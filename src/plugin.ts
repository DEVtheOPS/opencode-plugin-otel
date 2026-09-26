import { ROOT_CONTEXT } from "@opentelemetry/api"
import { SeverityNumber } from "@opentelemetry/api-logs"
import pkg from "../package.json" with { type: "json" }
import { loadConfig, parseAttributePairs, resolveHelperPath, resolveLogLevel, type OtelPluginOptions } from "./config.ts"
import { probeEndpoint } from "./probe.ts"
import { forceFlushOtel } from "./otel.ts"
import { remoteParentContext } from "./trace-context.ts"
import { acquireSharedOtel, acquireTracingState, flushSharedOtel, releaseSharedOtel } from "./state.ts"
import { LEVELS, type HandlerContext, type Level, type OpenCodeContext, type OpenCodeEvent } from "./types.ts"
import { agentAttrs, markSeen, setBoundedMap } from "./util.ts"
import {
  handleExecutionEnded,
  handleExecutionStarted,
  handleSessionCreated,
  handleSessionIdle,
  handleSessionStatus,
  handleUsageUpdated,
} from "./handlers/session.ts"
import { handleStepEnded, handleStepFailed, handleStepStarted } from "./handlers/step.ts"
import { handleToolCalled, handleToolFailed, handleToolInputStarted, handleToolSuccess } from "./handlers/tool.ts"
import { handlePermissionAsked, handlePermissionReplied } from "./handlers/permission.ts"
import { handleModelRequest } from "./handlers/chat-headers.ts"

const PLUGIN_VERSION: string = (pkg as { version?: string }).version ?? "unknown"
const EXIT_HOOK_KEY = "__opencode_plugin_otel_exit_hook__"

/**
 * OpenCode V2 plugin entrypoint. Sets up the OTel SDK, subscribes to the granular
 * V2 event stream (`session.*`), and emits spans, metrics, and log events mirroring
 * the Claude Code monitoring signals. All instrumentation is gated on
 * `OPENCODE_ENABLE_TELEMETRY` (or the `enabled` plugin option).
 */
export async function setup(ctx: OpenCodeContext): Promise<() => Promise<void>> {
  const config = loadConfig(ctx.options as OtelPluginOptions)
  const minLevel: Level = resolveLogLevel(config.logLevel ?? "info", "info")

  const log: HandlerContext["log"] = async (level, message, extra) => {
    if (LEVELS[level] < LEVELS[minLevel]) return
    const line = `[opencode-plugin-otel] ${message}`
    if (level === "error") console.error(line, extra ?? "")
    else if (level === "warn") console.warn(line, extra ?? "")
    else console.log(line, extra ?? "")
  }

  if (!config.enabled) {
    await log("info", "telemetry disabled (set OPENCODE_ENABLE_TELEMETRY or the enabled option to enable)")
    return async () => {}
  }

  config.otlpHeadersHelper = resolveHelperPath(
    config.otlpHeadersHelper,
    ctx.location.directory,
    ctx.location.project.directory,
  )

  await log("info", "starting up", {
    version: PLUGIN_VERSION,
    endpoint: config.endpoint,
    protocol: config.protocol,
    metricsInterval: config.metricsInterval,
    logsInterval: config.logsInterval,
    metricPrefix: config.metricPrefix,
    headersHelperSet: !!config.otlpHeadersHelper,
  })

  const probe = await probeEndpoint(config.endpoint)
  if (probe.ok) {
    await log("info", "OTLP endpoint reachable", { endpoint: config.endpoint, ms: probe.ms })
  } else {
    await log("warn", "OTLP endpoint unreachable — exports may fail", { endpoint: config.endpoint, error: probe.error })
  }

  const shared = await acquireSharedOtel(config, PLUGIN_VERSION)
  const tracing = acquireTracingState()
  await log("info", "OTel SDK initialized")

  const g = globalThis as Record<string, unknown>
  if (!g[EXIT_HOOK_KEY]) {
    g[EXIT_HOOK_KEY] = true
    process.once("beforeExit", () => {
      void flushSharedOtel()
    })
  }

  const emitLog: HandlerContext["emitLog"] = (record) => {
    if (!config.logsEnabled) return
    shared.logger.emit(record)
  }

  const remoteContext = remoteParentContext(config.traceparent, config.tracestate)
  if (config.traceparent && !remoteContext) {
    await log("warn", "invalid OPENCODE_TRACEPARENT ignored", { traceparentLength: config.traceparent.length })
  }

  const hctx: HandlerContext = {
    log,
    emitLog,
    instruments: shared.instruments,
    commonAttrs: {
      ...parseAttributePairs(config.spanAttributes),
      "project.id": ctx.location.project.id,
    } as const,
    disabledMetrics: config.disabledMetrics,
    disabledTraces: config.disabledTraces,
    tracer: shared.tracer,
    tracePrefix: config.metricPrefix,
    rootContext: remoteContext ? () => remoteContext : () => ROOT_CONTEXT,
    tracing,
    tracePropagationProviders: config.tracePropagationProviders,
  }

  if (config.disabledMetrics.size > 0) await log("info", "metrics disabled", { disabled: [...config.disabledMetrics] })
  if (config.disabledTraces.size > 0) await log("info", "traces disabled", { disabled: [...config.disabledTraces] })
  if (!config.logsEnabled) await log("info", "OTLP log events disabled")
  if (config.capturePromptInLogs) {
    await log("info", "prompt-in-logs capture enabled - full prompt text emitted in the `prompt` attribute of user_prompt log events")
  }

  await ctx.session.hook("prompt", (event) => {
    const prompt = event.prompt
    const parts = [prompt.text]
    for (const file of prompt.files ?? []) parts.push(file.name ?? file.uri)
    for (const agent of prompt.agents ?? []) parts.push(agent.name)
    for (const skill of prompt.skills ?? []) parts.push(skill.id)
    const text = parts.filter(Boolean).join("\n")
    setBoundedMap(tracing.pendingPrompts, event.sessionID, { text, startMs: Date.now() })
    const totals = tracing.sessionTotals.get(event.sessionID)
    emitLog({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      timestamp: Date.now(),
      observedTimestamp: Date.now(),
      body: "user_prompt",
      attributes: {
        "event.name": "user_prompt",
        "session.id": event.sessionID,
        ...(totals ? agentAttrs(totals.agent, totals.agentType) : {}),
        prompt_length: text.length,
        ...(config.capturePromptInLogs ? { prompt: text } : {}),
        delivery: event.delivery,
        ...hctx.commonAttrs,
      },
    })
  })

  await ctx.session.hook("model.request", (event) => {
    handleModelRequest(event, hctx)
  })

  const dispatch = async (event: OpenCodeEvent): Promise<void> => {
    switch (event.type) {
      case "session.created":
        handleSessionCreated(event, hctx)
        break
      case "session.execution.started":
        handleExecutionStarted(event, hctx)
        break
      case "session.execution.succeeded":
        handleExecutionEnded(event, hctx, { type: "succeeded" })
        await forceFlushOtel(shared.providers)
        break
      case "session.execution.failed":
        handleExecutionEnded(event, hctx, { type: "failed", error: event.data.error })
        await forceFlushOtel(shared.providers)
        break
      case "session.execution.interrupted":
        handleExecutionEnded(event, hctx, { type: "interrupted", reason: event.data.reason })
        await forceFlushOtel(shared.providers)
        break
      case "session.status":
        handleSessionStatus(event, hctx)
        break
      case "session.idle":
        handleSessionIdle(event, hctx)
        await forceFlushOtel(shared.providers)
        break
      case "session.usage.updated":
        handleUsageUpdated(event, hctx)
        break
      case "session.step.started":
        handleStepStarted(event, hctx)
        break
      case "session.step.ended":
        handleStepEnded(event, hctx)
        break
      case "session.step.failed":
        handleStepFailed(event, hctx)
        break
      case "session.tool.input.started":
        handleToolInputStarted(event, hctx)
        break
      case "session.tool.called":
        handleToolCalled(event, hctx)
        break
      case "session.tool.success":
        handleToolSuccess(event, hctx)
        break
      case "session.tool.failed":
        handleToolFailed(event, hctx)
        break
      case "permission.asked":
        handlePermissionAsked(event, hctx)
        break
      case "permission.replied":
        handlePermissionReplied(event, hctx)
        break
      default:
        break
    }
  }

  const controller = new AbortController()
  const running = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (tracing.seenEvents.has(event.id)) continue
        markSeen(tracing.seenEvents, event.id)
        await dispatch(event)
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        await log("error", "otel: event subscription ended", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  })()

  return async () => {
    controller.abort()
    await running.catch(() => {})
    await forceFlushOtel(shared.providers)
    await releaseSharedOtel()
  }
}
