import { ROOT_CONTEXT } from "@opentelemetry/api"
import pkg from "../package.json" with { type: "json" }
import { loadConfig, parseAttributePairs, resolveHelperPath, resolveLogLevel, type OtelPluginOptions } from "./config.ts"
import { probeEndpoint } from "./probe.ts"
import { forceFlushOtel } from "./otel.ts"
import { remoteParentContext } from "./trace-context.ts"
import { acquireSharedOtel, acquireTracingState, flushSharedOtel, releaseSharedOtel } from "./state.ts"
import { LEVELS, type HandlerContext, type Level, type OpenCodeContext, type OpenCodeEvent } from "./types.ts"
import { contextForSession, markSeen, setBoundedMap } from "./util.ts"
import {
  finalizeSession,
  handleExecutionEnded,
  handleExecutionStarted,
  handlePromptEnqueued,
  handleSessionCreated,
  handleSessionIdle,
  handleRetryScheduled,
  handleSessionStatus,
  handleUsageUpdated,
} from "./handlers/session.ts"
import { handleStepEnded, handleStepFailed, handleStepStarted, handleTextEnded } from "./handlers/step.ts"
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
    commonAttrs: parseAttributePairs(config.spanAttributes),
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

  const scoped = (sessionID: string) => contextForSession(
    sessionID,
    hctx,
    async (id) => (await ctx.session.get({ sessionID: id })).projectID,
  )

  await ctx.session.hook("model.request", (event) => {
    handleModelRequest(event, hctx)
  })

  const dispatch = async (event: OpenCodeEvent): Promise<void> => {
    if (event.type === "session.created") {
      setBoundedMap(tracing.sessionProjects, event.data.sessionID, event.data.projectID)
    }
    const sessionID = "sessionID" in event.data && typeof event.data.sessionID === "string"
      ? event.data.sessionID
      : undefined
    const eventCtx = sessionID ? await scoped(sessionID) : hctx
    switch (event.type) {
      case "session.created":
        handleSessionCreated(event, eventCtx)
        break
      case "session.inbox.enqueued":
        handlePromptEnqueued(event, eventCtx, config.capturePromptInLogs)
        break
      case "session.execution.started":
        handleExecutionStarted(event, eventCtx)
        break
      case "session.execution.succeeded":
        handleExecutionEnded(event, eventCtx, { type: "succeeded" })
        finalizeSession(event.data.sessionID, eventCtx)
        await forceFlushOtel(shared.providers)
        break
      case "session.execution.failed":
        handleExecutionEnded(event, eventCtx, { type: "failed", error: event.data.error })
        finalizeSession(event.data.sessionID, eventCtx)
        await forceFlushOtel(shared.providers)
        break
      case "session.execution.interrupted":
        handleExecutionEnded(event, eventCtx, { type: "interrupted", reason: event.data.reason })
        finalizeSession(event.data.sessionID, eventCtx)
        await forceFlushOtel(shared.providers)
        break
      case "session.status":
        handleSessionStatus(event, eventCtx)
        break
      case "session.idle":
        handleSessionIdle(event, eventCtx)
        await forceFlushOtel(shared.providers)
        break
      case "session.usage.updated":
        handleUsageUpdated(event, eventCtx)
        break
      case "session.retry.scheduled":
        handleRetryScheduled(event, eventCtx)
        break
      case "session.step.started":
        handleStepStarted(event, eventCtx)
        break
      case "session.text.ended":
        handleTextEnded(event, eventCtx)
        break
      case "session.step.ended":
        handleStepEnded(event, eventCtx)
        break
      case "session.step.failed":
        handleStepFailed(event, eventCtx)
        break
      case "session.tool.input.started":
        handleToolInputStarted(event, eventCtx)
        break
      case "session.tool.called":
        handleToolCalled(event, eventCtx)
        break
      case "session.tool.success":
        handleToolSuccess(event, eventCtx)
        break
      case "session.tool.failed":
        handleToolFailed(event, eventCtx)
        break
      case "permission.asked":
        handlePermissionAsked(event, eventCtx)
        break
      case "permission.replied":
        handlePermissionReplied(event, eventCtx)
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
        try {
          await dispatch(event)
        } catch (err) {
          await log("error", "otel: failed to handle event", {
            type: event.type,
            error: err instanceof Error ? err.message : String(err),
          })
        }
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
