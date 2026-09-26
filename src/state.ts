import { trace } from "@opentelemetry/api"
import { logs } from "@opentelemetry/api-logs"
import { createInstruments, forceFlushOtel, setupOtel } from "./otel.ts"
import type { PluginConfig } from "./config.ts"
import type { SharedOtel, TracingState } from "./types.ts"

const OTEL_KEY = "__opencode_plugin_otel_shared__"
const OTEL_PENDING_KEY = "__opencode_plugin_otel_pending__"
const TRACING_KEY = "__opencode_plugin_otel_tracing__"

type Globals = Record<string, unknown>

function globals(): Globals {
  return globalThis as unknown as Globals
}

/**
 * Returns the process-wide shared OTel SDK instance, creating it on first use.
 * OpenCode may load one plugin instance per location, but `setGlobalMeterProvider`
 * and friends may only be effectively registered once per process, so providers are
 * shared and reference-counted rather than recreated per instance.
 */
export async function acquireSharedOtel(config: PluginConfig, version: string): Promise<SharedOtel> {
  const g = globals()
  const existing = g[OTEL_KEY] as SharedOtel | undefined
  if (existing) {
    existing.refs += 1
    return existing
  }

  if (!g[OTEL_PENDING_KEY]) {
    g[OTEL_PENDING_KEY] = (async (): Promise<SharedOtel> => {
      const providers = await setupOtel(
        config.endpoint,
        config.protocol,
        config.metricsInterval,
        config.logsInterval,
        version,
        config.otlpHeaders,
        config.otlpHeadersHelper,
      )
      const shared: SharedOtel = {
        providers,
        instruments: createInstruments(config.metricPrefix),
        logger: logs.getLogger("com.opencode"),
        tracer: trace.getTracer("com.opencode"),
        refs: 0,
      }
      g[OTEL_KEY] = shared
      g[OTEL_PENDING_KEY] = undefined
      return shared
    })()
  }

  const shared = await (g[OTEL_PENDING_KEY] as Promise<SharedOtel>)
  shared.refs += 1
  return shared
}

/**
 * Flushes shared telemetry and releases one reference. The providers are never
 * shut down: doing so poisons the OTel global registry for the rest of the
 * process and would silently drop telemetry from later plugin instances.
 */
export async function releaseSharedOtel(): Promise<void> {
  const shared = globals()[OTEL_KEY] as SharedOtel | undefined
  if (!shared) return
  shared.refs = Math.max(0, shared.refs - 1)
  await forceFlushOtel(shared.providers)
}

/** Flushes shared telemetry without releasing a reference (best-effort, e.g. on process exit). */
export async function flushSharedOtel(): Promise<void> {
  const shared = globals()[OTEL_KEY] as SharedOtel | undefined
  if (shared) await forceFlushOtel(shared.providers)
}

/** Returns the process-wide tracing correlation state, creating it on first use. */
export function acquireTracingState(): TracingState {
  const g = globals()
  let state = g[TRACING_KEY] as TracingState | undefined
  if (!state) {
    state = {
      seenEvents: new Set(),
      runSpans: new Map(),
      runSpanContexts: new Map(),
      stepSpans: new Map(),
      stepSpanContexts: new Map(),
      toolSpans: new Map(),
      toolSpanContexts: new Map(),
      toolMeta: new Map(),
      stepMeta: new Map(),
      sessionTotals: new Map(),
      countedSessions: new Set(),
      countedMessages: new Set(),
      pendingPrompts: new Map(),
      pendingPermissions: new Map(),
      activeLlm: new Map(),
    }
    g[TRACING_KEY] = state
  }
  return state
}
