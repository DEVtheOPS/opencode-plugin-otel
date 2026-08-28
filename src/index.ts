import type { Plugin } from "@opencode-ai/plugin"
import { SeverityNumber } from "@opentelemetry/api-logs"
import { logs } from "@opentelemetry/api-logs"
import { ROOT_CONTEXT, trace } from "@opentelemetry/api"
import { AGENT_NAME } from "@arizeai/openinference-semantic-conventions"
import pkg from "../package.json" with { type: "json" }
import type {
  EventSessionCreated,
  EventSessionIdle,
  EventSessionError,
  EventSessionStatus,
  EventMessageUpdated,
  EventMessagePartUpdated,
  EventPermissionUpdated,
  EventPermissionReplied,
  EventSessionDiff,
  EventCommandExecuted,
} from "@opencode-ai/sdk"
import { LEVELS, type Level, type HandlerContext } from "./types.ts"
import { loadConfig, parseAttributePairs, resolveHelperPath, resolveLogLevel, type OtelPluginOptions } from "./config.ts"
import { probeEndpoint } from "./probe.ts"
import { setupOtel, createInstruments, forceFlushOtel } from "./otel.ts"
import { remoteParentContext } from "./trace-context.ts"
import { handleSessionCreated, handleSessionIdle, handleSessionError, handleSessionStatus, handleRunStarted } from "./handlers/session.ts"
import { handleMessageUpdated, handleMessagePartUpdated, startMessageSpan } from "./handlers/message.ts"
import { handlePermissionUpdated, handlePermissionReplied } from "./handlers/permission.ts"
import { handleSessionDiff, handleCommandExecuted } from "./handlers/activity.ts"
import { handleChatHeaders } from "./handlers/chat-headers.ts"
import { agentAttrs, getSessionAgentMeta, resolveSessionTraceContext, setBoundedMap } from "./util.ts"
import type { SessionTotals } from "./types.ts"

const PLUGIN_VERSION: string = (pkg as { version?: string }).version ?? "unknown"

/**
 * OpenCode plugin that exports session telemetry via OpenTelemetry (OTLP over gRPC or HTTP/protobuf).
 * Instruments metrics (sessions, tokens, cost, lines of code, commits, tool durations)
 * and structured log events. All instrumentation is gated on `OPENCODE_ENABLE_TELEMETRY`.
 */
export const OtelPlugin: Plugin = async ({ project, client, directory, worktree }, options) => {
  const config = loadConfig(options as OtelPluginOptions)
  const otlpHeadersHelper = resolveHelperPath(config.otlpHeadersHelper, directory, worktree)
  let minLevel: Level = "info"

  const log: HandlerContext["log"] = async (level, message, extra) => {
    if (LEVELS[level] < LEVELS[minLevel]) return
    await client.app.log({ body: { service: "opencode-plugin-otel", level, message, extra } })
  }

  if (!config.enabled) {
    await log("info", "telemetry disabled (set OPENCODE_ENABLE_TELEMETRY to enable)")
    return {}
  }

  await log("info", "starting up", {
    version: PLUGIN_VERSION,
    endpoint: config.endpoint,
    protocol: config.protocol,
    metricsInterval: config.metricsInterval,
    logsInterval: config.logsInterval,
    metricPrefix: config.metricPrefix,
    headersHelperSet: !!config.otlpHeadersHelper,
  })

  await log("debug", "config loaded", {
    headersSet: !!config.otlpHeaders,
    headersHelperSet: !!config.otlpHeadersHelper,
    resourceAttributesSet: !!config.resourceAttributes,
    spanAttributesSet: !!config.spanAttributes,
  })

  const probe = await probeEndpoint(config.endpoint)
  if (probe.ok) {
    await log("info", "OTLP endpoint reachable", { endpoint: config.endpoint, ms: probe.ms })
  } else {
    await log("warn", "OTLP endpoint unreachable — exports may fail", {
      endpoint: config.endpoint,
      error: probe.error,
    })
  }

  const providers = await setupOtel(
    config.endpoint,
    config.protocol,
    config.metricsInterval,
    config.logsInterval,
    PLUGIN_VERSION,
    config.otlpHeaders,
    otlpHeadersHelper,
  )
  const { meterProvider, loggerProvider, tracerProvider } = providers
  await log("info", "OTel SDK initialized")

  const instruments = createInstruments(config.metricPrefix)
  const logger = logs.getLogger("com.opencode")
  const emitLog: HandlerContext["emitLog"] = (record) => {
    if (!config.logsEnabled) return
    logger.emit(record)
  }
  const tracer = trace.getTracer("com.opencode")
  const remoteContext = remoteParentContext(config.traceparent, config.tracestate)
  if (config.traceparent && !remoteContext) {
    await log("warn", "invalid OPENCODE_TRACEPARENT ignored", { traceparentLength: config.traceparent.length })
  }
  const rootContext = remoteContext ? () => remoteContext : () => ROOT_CONTEXT
  const pendingToolSpans = new Map()
  const pendingPermissions = new Map()
  const sessionTotals = new Map()
  const sessionDiffTotals = new Map()
  const runSpans = new Map()
  const runSpanContexts = new Map()
  const activeRuns = new Map()
  const assistantRuns = new Map()
  const pendingRuns = new Map()
  const runInputs = new Map()
  const sessionSpans = new Map()
  const sessionSpanContexts = new Map()
  const messageSpans = new Map()
  const messageOutputs = new Map()
  const llmRequestContexts = new Map()
  const { disabledMetrics, disabledTraces } = config
  const commonAttrs = {
    ...parseAttributePairs(config.spanAttributes),
    "project.id": project.id,
  } as const

  if (disabledMetrics.size > 0) {
    await log("info", "metrics disabled", { disabled: [...disabledMetrics] })
  }

  if (disabledTraces.size > 0) {
    await log("info", "traces disabled", { disabled: [...disabledTraces] })
  }

  if (!config.logsEnabled) {
    await log("info", "OTLP log events disabled")
  }

  if (config.capturePromptInLogs) {
    await log(
      "info",
      "prompt-in-logs capture enabled - full prompt text emitted in the `prompt` attribute of user_prompt log events (spans always carry the prompt regardless)",
    )
  }

  const ctx: HandlerContext = {
    log,
    emitLog,
    instruments,
    commonAttrs,
    pendingToolSpans,
    pendingPermissions,
    sessionTotals,
    sessionDiffTotals,
    disabledMetrics,
    disabledTraces,
    tracer,
    tracePrefix: config.metricPrefix,
    rootContext,
    runSpans,
    runSpanContexts,
    activeRuns,
    assistantRuns,
    pendingRuns,
    runInputs,
    sessionSpans,
    sessionSpanContexts,
    messageSpans,
    messageOutputs,
    llmRequestContexts,
    tracePropagationProviders: config.tracePropagationProviders,
  }

  let shuttingDown = false

  async function flushTelemetry(reason: string) {
    if (shuttingDown) return
    await forceFlushOtel(providers)
    await log("debug", "otel: telemetry flushed", { reason })
  }

  async function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    await forceFlushOtel(providers)
    await Promise.allSettled([meterProvider.shutdown(), loggerProvider.shutdown(), tracerProvider.shutdown()])
  }

  process.on("SIGTERM", () => { shutdown().then(() => process.exit(0)).catch(() => process.exit(1)) })
  process.on("SIGINT",  () => { shutdown().then(() => process.exit(0)).catch(() => process.exit(1)) })
  process.on("beforeExit", () => { shutdown().catch(() => {}) })

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

  return {
    config: async (cfg) => {
      if (cfg.logLevel) {
        const next = resolveLogLevel(cfg.logLevel, minLevel)
        if (next !== minLevel) {
          minLevel = next
          await log("info", `log level set to "${minLevel}"`)
        } else if (cfg.logLevel.toLowerCase() !== minLevel) {
          await log("warn", `unknown log level "${cfg.logLevel}", keeping "${minLevel}"`)
        }
      }
    },

    "chat.headers": safe("chat.headers", async (input, output) => {
      handleChatHeaders(input, output, ctx)
    }),

    "chat.message": safe("chat.message", async (input, output) => {
      const agent = input.agent ?? "unknown"
      const startTime = Date.now()
      const existingTotals = sessionTotals.get(input.sessionID)
      const nextTotals: SessionTotals = {
        startMs: existingTotals?.startMs ?? startTime,
        tokens: existingTotals?.tokens ?? 0,
        cost: existingTotals?.cost ?? 0,
        messages: existingTotals?.messages ?? 0,
        agent,
        agentType: existingTotals?.agentType ?? "primary",
      }
      setBoundedMap(sessionTotals, input.sessionID, nextTotals)
      const { agentType } = getSessionAgentMeta(input.sessionID, ctx)
      const sessionSpan = sessionSpans.get(input.sessionID)
      if (sessionSpan) sessionSpan.setAttributes({ [AGENT_NAME]: agent, "agent.type": agentType })
      const promptText = output.parts.map((part) => {
        switch (part.type) {
          case "text":
            return part.text
          case "file":
            return part.filename ?? part.url
          case "agent":
            return part.name
          case "subtask":
            return part.description
          default:
            return ""
        }
      }).filter(Boolean).join("\n")
      if (!sessionSpan) {
        const model = input.model ? `${input.model.providerID}/${input.model.modelID}` : "unknown"
        if (input.messageID) {
          handleRunStarted(
            input.messageID,
            input.sessionID,
            agent,
            promptText,
            model,
            startTime,
            ctx,
          )
        } else {
          setBoundedMap(pendingRuns, input.sessionID, {
            agent,
            promptText,
            model,
            startTime,
          })
        }
      }
      const promptLength = promptText.length
      emitLog({
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
        timestamp: startTime,
        observedTimestamp: startTime,
        body: "user_prompt",
        attributes: {
          "event.name": "user_prompt",
          "session.id": input.sessionID,
          ...agentAttrs(agent, agentType),
          prompt_length: promptLength,
          ...(config.capturePromptInLogs ? { prompt: promptText } : {}),
          model: input.model
            ? `${input.model.providerID}/${input.model.modelID}`
            : "unknown",
          ...commonAttrs,
        },
        context: resolveSessionTraceContext(input.sessionID, ctx),
      })
    }),

    event: safe("event", async ({ event }) => {
      switch (event.type) {
        case "session.created":
          await handleSessionCreated(event as EventSessionCreated, ctx)
          break
        case "session.idle":
          handleSessionIdle(event as EventSessionIdle, ctx)
          await flushTelemetry("session.idle")
          break
        case "session.error":
          handleSessionError(event as EventSessionError, ctx)
          await flushTelemetry("session.error")
          break
        case "session.status":
          handleSessionStatus(event as EventSessionStatus, ctx)
          break
        case "session.diff":
          handleSessionDiff(event as EventSessionDiff, ctx)
          break
        case "command.executed":
          handleCommandExecuted(event as EventCommandExecuted, ctx)
          break
        case "permission.updated":
          handlePermissionUpdated(event as EventPermissionUpdated, ctx)
          break
        case "permission.replied":
          handlePermissionReplied(event as EventPermissionReplied, ctx)
          break
        case "message.updated": {
          const msgEvt = event as EventMessageUpdated
          const info = msgEvt.properties.info
          if (info.role === "user") {
            const pendingRun = pendingRuns.get(info.sessionID)
            if (!sessionSpans.has(info.sessionID) && (pendingRun || activeRuns.get(info.sessionID) !== info.id)) {
              handleRunStarted(
                info.id,
                info.sessionID,
                pendingRun?.agent ?? info.agent,
                pendingRun?.promptText ?? "",
                pendingRun?.model ?? `${info.model.providerID}/${info.model.modelID}`,
                pendingRun?.startTime ?? info.time.created,
                ctx,
              )
            }
            break
          }
          if (info.role === "assistant" && !info.time?.completed) {
            startMessageSpan(
              info.sessionID,
              info.id,
              info.parentID,
              info.modelID ?? "unknown",
              info.providerID ?? "unknown",
              info.time?.created ?? Date.now(),
              ctx,
              info.mode,
            )
          }
          await handleMessageUpdated(msgEvt, ctx)
          if (info.role === "assistant" && info.time?.completed) {
            await flushTelemetry("message.completed")
          }
          break
        }
        case "message.part.updated":
          await handleMessagePartUpdated(event as EventMessagePartUpdated, ctx)
          break
      }
    }),
  }
}
