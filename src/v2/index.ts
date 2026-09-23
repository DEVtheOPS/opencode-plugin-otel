import { logs } from "@opentelemetry/api-logs"
import { diag, DiagLogLevel, ROOT_CONTEXT, trace } from "@opentelemetry/api"
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { LEVELS, type HandlerContext, type Level } from "./types.ts"
import { loadConfig, parseAttributePairs, resolveHelperPath, type OtelPluginOptions } from "../config.ts"
import { probeEndpoint } from "../probe.ts"
import { createInstruments, forceFlushOtel, setupOtel, type OtelProviders } from "../otel.ts"
import { remoteParentContext } from "../trace-context.ts"
import {
  handleExecutionEnded,
  handleExecutionFailed,
  handleExecutionStarted,
  handleRunStarted,
  handleSessionCreated,
  handleSessionIdle,
  handleSessionStatus,
} from "./handlers/session.ts"
import { handleStepEnded, handleStepStarted, handleUsageUpdated } from "./handlers/usage.ts"
import {
  handleToolCalled,
  handleToolFailed,
  handleToolInputStarted,
  handleToolSuccess,
} from "./handlers/tool.ts"
import { handleModelRequest } from "./handlers/chat-headers.ts"
import { setBoundedMap } from "../util.ts"
import { redactSecrets } from "../redact.ts"
import type { V2Event } from "./v2.ts"

const PLUGIN_VERSION = "2.0.0-v2-port"

/** Append-only diagnostics for debugging the live plugin (server console output is not captured). */
const DIAG_LOG =
  process.env["OPENCODE_OTEL_DIAG_LOG"] ??
  join(homedir(), ".local", "share", "opencode", "otel-plugin-diag.log")
function diagLog(message: string) {
  try {
    mkdirSync(dirname(DIAG_LOG), { recursive: true })
    if (((statSync(DIAG_LOG, { throwIfNoEntry: false })?.size) ?? 0) > 1_000_000) writeFileSync(DIAG_LOG, "")
    appendFileSync(DIAG_LOG, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* ignore */
  }
}

/** Resolves `{env:VAR}` placeholders from the process environment as a fallback to V2 config interpolation. */
function resolveEnv(value: string | undefined): string | undefined {
  if (!value) return value
  return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "")
}

// V2 loads a global plugin once per location, and evaluates the module per instance, so
// module-level state is not shared. The OTel SDK's global providers may only be registered
// once per process, so the instance is stored on `globalThis` and reused. Providers are
// flushed (never shut down) on release: shutting a global provider down poisons the OTel
// registry for the rest of the process, which would silently drop all later telemetry.
const SHARED_KEY = "__opencode_otel_shared_v1__"

type SharedOtel = {
  providers: OtelProviders
  instruments: ReturnType<typeof createInstruments>
  logger: ReturnType<typeof logs.getLogger>
  tracer: ReturnType<typeof trace.getTracer>
  refs: number
}

type SharedState = { promise: Promise<SharedOtel> | null; instance: SharedOtel | null }

function sharedState(): SharedState {
  const g = globalThis as unknown as Record<string, SharedState | undefined>
  if (!g[SHARED_KEY]) g[SHARED_KEY] = { promise: null, instance: null }
  return g[SHARED_KEY]!
}

// Tracing bookkeeping is keyed by session/message id and must be shared across every plugin
// instance in the process, otherwise a run span created by one instance's hook is invisible
// to the instance handling the matching event, and child spans become separate root traces.
const TRACING_KEY = "__opencode_otel_tracing_v1__"

type TracingState = {
  seenEvents: Set<string>
  runPrompts: Map<string, string>
  promptEmitted: Set<string>
  pendingToolSpans: HandlerContext["pendingToolSpans"]
  pendingToolNames: HandlerContext["pendingToolNames"]
  sessionTotals: HandlerContext["sessionTotals"]
  sessionMeta: HandlerContext["sessionMeta"]
  runSpans: HandlerContext["runSpans"]
  runSpanContexts: HandlerContext["runSpanContexts"]
  activeRuns: HandlerContext["activeRuns"]
  assistantRuns: HandlerContext["assistantRuns"]
  sessionSpans: HandlerContext["sessionSpans"]
  sessionSpanContexts: HandlerContext["sessionSpanContexts"]
  stepSpans: HandlerContext["stepSpans"]
  llmRequestContexts: HandlerContext["llmRequestContexts"]
}

function emptyTracing(): TracingState {
  return {
    seenEvents: new Set(),
    runPrompts: new Map(),
    promptEmitted: new Set(),
    pendingToolSpans: new Map(),
    pendingToolNames: new Map(),
    sessionTotals: new Map(),
    sessionMeta: new Map(),
    runSpans: new Map(),
    runSpanContexts: new Map(),
    activeRuns: new Map(),
    assistantRuns: new Map(),
    sessionSpans: new Map(),
    sessionSpanContexts: new Map(),
    stepSpans: new Map(),
    llmRequestContexts: new Map(),
  }
}

function tracingState(): TracingState {
  const g = globalThis as unknown as Record<string, TracingState | undefined>
  const existing = g[TRACING_KEY]
  if (existing) {
    // Backfill fields added since the object was first created, so a plugin reload
    // against a long-lived process cannot leave new fields undefined.
    const defaults = emptyTracing()
    for (const key of Object.keys(defaults) as (keyof TracingState)[]) {
      if (existing[key] === undefined) (existing as Record<string, unknown>)[key] = defaults[key]
    }
    return existing
  }
  const created = emptyTracing()
  g[TRACING_KEY] = created
  return created
}

async function acquireOtel(input: {
  config: ReturnType<typeof loadConfig>
  otlpHeaders: string | undefined
  helper: string | undefined
}): Promise<SharedOtel> {
  const state = sharedState()
  if (!state.promise) {
    state.promise = (async () => {
      diag.setLogger(
        {
          error: (...args: unknown[]) => diagLog(`OTEL ERROR ${args.map(String).join(" ")}`),
          warn: (...args: unknown[]) => diagLog(`OTEL WARN ${args.map(String).join(" ")}`),
          info: () => {},
          debug: () => {},
          verbose: () => {},
        },
        DiagLogLevel.WARN,
      )
      const providers = await setupOtel(
        input.config.endpoint,
        input.config.protocol,
        input.config.metricsInterval,
        input.config.logsInterval,
        PLUGIN_VERSION,
        input.otlpHeaders,
        input.helper,
      )
      const instance: SharedOtel = {
        providers,
        instruments: createInstruments(input.config.metricPrefix),
        logger: logs.getLogger("com.opencode"),
        tracer: trace.getTracer("com.opencode"),
        refs: 0,
      }
      state.instance = instance
      diagLog(`otel shared instance initialized endpoint=${input.config.endpoint} protocol=${input.config.protocol}`)
      return instance
    })()
  }
  const instance = await state.promise
  instance.refs++
  diagLog(`otel shared instance acquired refs=${instance.refs}`)
  return instance
}

async function releaseOtel() {
  const instance = sharedState().instance
  if (!instance) return
  instance.refs--
  diagLog(`otel shared instance released refs=${instance.refs}`)
  if (instance.refs <= 0) {
    await forceFlushOtel(instance.providers).catch(() => {})
  }
}

/**
 * V2 port of @devtheops/opencode-plugin-otel (scoped v0.1).
 *
 * Emits session lifecycle, usage/token/cost, LLM step, tool, retry, and execution
 * telemetry from the V2 granular event stream. V1-only signals (message parts,
 * permission prompts, command execution, session diffs) are out of scope; see README.
 */
export default {
  id: "devtheops.otel",
  async setup(ctx: any) {
    const options = (ctx?.options ?? {}) as OtelPluginOptions
    const config = loadConfig(options)
    const directory: string | undefined = ctx?.location?.directory
    const worktree: string | undefined =
      ctx?.location?.project?.canonical ?? ctx?.location?.project?.directory
    const otlpHeadersHelper = resolveHelperPath(config.otlpHeadersHelper, directory, worktree)

    const minLevel: Level = "info"
    const log: HandlerContext["log"] = async (level, message, extra) => {
      diagLog(`log ${level}: ${message} ${extra ? JSON.stringify(extra) : ""}`)
      if (LEVELS[level] < LEVELS[minLevel]) return
      const line = `[opencode-plugin-otel] ${level}: ${message}`
      if (level === "error") console.error(line, extra ?? "")
      else if (level === "warn") console.warn(line, extra ?? "")
      else console.log(line, extra ?? "")
    }

    if (!config.enabled) {
      await log("info", "telemetry disabled (set OPENCODE_ENABLE_TELEMETRY to enable)")
      return
    }

    const probe = await probeEndpoint(config.endpoint)
    if (!probe.ok) {
      await log("warn", "OTLP endpoint unreachable — exports may fail", {
        endpoint: config.endpoint,
        error: probe.error,
      })
    }

    const shared = await acquireOtel({
      config,
      otlpHeaders: resolveEnv(config.otlpHeaders),
      helper: otlpHeadersHelper,
    })
    const { instruments, logger, tracer, providers } = shared

    await log("info", "starting up", {
      version: PLUGIN_VERSION,
      endpoint: config.endpoint,
      protocol: config.protocol,
      metricsInterval: config.metricsInterval,
      logsInterval: config.logsInterval,
      metricPrefix: config.metricPrefix,
      headersHelperSet: !!config.otlpHeadersHelper,
      redactSecrets: config.redactSecrets,
      redactValueCount: config.redactValues.length,
    })

    const emitLog: HandlerContext["emitLog"] = (record, context) => {
      if (!config.logsEnabled) return
      logger.emit(context ? { ...record, context } : record)
    }
    const remoteContext = remoteParentContext(config.traceparent, config.tracestate)
    const rootContext = remoteContext ? () => remoteContext : () => ROOT_CONTEXT

    const commonAttrs = {
      ...parseAttributePairs(config.spanAttributes),
      "project.id": ctx?.location?.project?.id ?? "unknown",
    } as const

    const tracing = tracingState()
    const hctx: HandlerContext = {
      log,
      emitLog,
      instruments,
      commonAttrs,
      pendingToolSpans: tracing.pendingToolSpans,
      pendingToolNames: tracing.pendingToolNames,
      sessionTotals: tracing.sessionTotals,
      sessionMeta: tracing.sessionMeta,
      disabledMetrics: config.disabledMetrics,
      disabledTraces: config.disabledTraces,
      tracer,
      tracePrefix: config.metricPrefix,
      rootContext,
      runSpans: tracing.runSpans,
      runSpanContexts: tracing.runSpanContexts,
      activeRuns: tracing.activeRuns,
      assistantRuns: tracing.assistantRuns,
      sessionSpans: tracing.sessionSpans,
      sessionSpanContexts: tracing.sessionSpanContexts,
      stepSpans: tracing.stepSpans,
      llmRequestContexts: tracing.llmRequestContexts,
      tracePropagationProviders: config.tracePropagationProviders,
      capturePromptInLogs: config.capturePromptInLogs,
      redact: config.redactSecrets
        ? (text: string) => redactSecrets(text, config.redactValues)
        : (text: string) => text,
      runPrompts: tracing.runPrompts,
      promptEmitted: tracing.promptEmitted,
    }

    const safe = <T extends unknown[]>(
      name: string,
      fn: (...args: T) => Promise<void> | void,
    ): ((...args: T) => Promise<void>) =>
      async (...args: T) => {
        try {
          await fn(...args)
        } catch (err) {
          await log("error", `otel: unhandled error in ${name}`, {
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          })
        }
      }

    // Prompt admission: start the root run span for the user turn.
    await ctx.session.hook(
      "prompt",
      safe("prompt", async (event: any) => {
        diagLog(`hook prompt session=${event?.sessionID} msg=${event?.messageID}`)
        const sessionID = event?.sessionID
        let meta = hctx.sessionMeta.get(sessionID)
        if (!meta || meta.agent === "unknown" || meta.model === "unknown") {
          try {
            const info: any = await ctx.session.get({ sessionID })
            const s: any = info?.data ?? info
            meta = {
              agent: s?.agent ?? meta?.agent ?? "unknown",
              model: s?.model ? `${s.model.providerID}/${s.model.id}` : (meta?.model ?? "unknown"),
            }
            diagLog(
              `prompt enrich session=${sessionID} rawKeys=${Object.keys(info ?? {}).join(",")} agent=${meta.agent} model=${meta.model}`,
            )
            setBoundedMap(hctx.sessionMeta, sessionID, meta)
          } catch (err) {
            diagLog(`prompt enrich failed session=${sessionID}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        const agent = meta?.agent ?? hctx.sessionTotals.get(sessionID)?.agent ?? "unknown"
        const model = meta?.model ?? "unknown"
        const promptText: string = event?.prompt?.text ?? ""
        handleRunStarted(event.messageID, sessionID, agent, promptText, model, Date.now(), hctx)
        // The user_prompt log is emitted on the first step, where agent/model are resolved.
        setBoundedMap(hctx.runPrompts, event.messageID, promptText)
      }),
    )

    // Model request: inject W3C trace context for enabled providers.
    await ctx.session.hook(
      "model.request",
      safe("model.request", (event: any) => {
        handleModelRequest(
          {
            sessionID: event.sessionID,
            agent: event.agent,
            model: event.model,
            headers: event.headers,
          },
          hctx,
        )
      }),
    )

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal }) as AsyncIterable<V2Event>) {
          // V2 delivers each event to every plugin instance; process it exactly once.
          const eventID = event.id
          if (eventID) {
            if (tracing.seenEvents.has(eventID)) continue
            tracing.seenEvents.add(eventID)
            if (tracing.seenEvents.size > 5000) {
              const oldest = tracing.seenEvents.values().next().value
              if (oldest) tracing.seenEvents.delete(oldest)
            }
          }
          await safe(`event:${event.type}`, async () => {
            switch (event.type) {
              case "session.created":
                await handleSessionCreated(event.data as any, event.created, hctx)
                break
              case "session.idle":
                handleSessionIdle((event.data as any).sessionID, hctx)
                await forceFlushOtel(providers)
                break
              case "session.status":
                handleSessionStatus(event.data as any, hctx)
                break
              case "session.usage.updated":
                handleUsageUpdated(event.data as any, hctx)
                break
              case "session.step.started":
                handleStepStarted(event.data as any, hctx)
                break
              case "session.step.ended":
                handleStepEnded(event.data as any, hctx)
                break
              case "session.step.failed":
                handleStepEnded(event.data as any, hctx, (event.data as any).error)
                await forceFlushOtel(providers)
                break
              case "session.tool.input.started":
                handleToolInputStarted(event.data as any, hctx)
                break
              case "session.tool.called":
                handleToolCalled(event.data as any, hctx)
                break
              case "session.tool.success":
                handleToolSuccess(event.data as any, hctx)
                break
              case "session.tool.failed":
                handleToolFailed(event.data as any, hctx)
                break
              case "session.execution.started":
                handleExecutionStarted(event.data as any, hctx)
                break
              case "session.execution.succeeded":
                handleExecutionEnded(event.data as any, hctx)
                await forceFlushOtel(providers)
                break
              case "session.execution.failed":
                handleExecutionFailed(event.data as any, hctx)
                await forceFlushOtel(providers)
                break
              case "session.execution.interrupted":
                handleExecutionEnded(event.data as any, hctx)
                await forceFlushOtel(providers)
                break
            }
          })()
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          await log("error", "otel: event subscription ended", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    })()

    await log("info", "plugin ready", { version: PLUGIN_VERSION })

    return async () => {
      controller.abort()
      await releaseOtel()
    }
  },
}
