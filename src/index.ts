import type { Plugin } from "@opencode-ai/plugin"
import { SeverityNumber } from "@opentelemetry/api-logs"
import { logs } from "@opentelemetry/api-logs"
import { trace } from "@opentelemetry/api"
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
import { loadConfig, resolveLogLevel } from "./config.ts"
import { probeEndpoint } from "./probe.ts"
import { setupOtel, createInstruments } from "./otel.ts"
import { handleSessionCreated, handleSessionIdle, handleSessionError, handleSessionStatus } from "./handlers/session.ts"
import { handleMessageUpdated, handleMessagePartUpdated, startMessageSpan } from "./handlers/message.ts"
import { handlePermissionUpdated, handlePermissionReplied } from "./handlers/permission.ts"
import { handleSessionDiff, handleCommandExecuted } from "./handlers/activity.ts"

const PLUGIN_VERSION: string = (pkg as { version?: string }).version ?? "unknown"

/**
 * OpenCode plugin that exports session telemetry via OpenTelemetry (OTLP over gRPC or HTTP/protobuf).
 * Instruments metrics (sessions, tokens, cost, lines of code, commits, tool durations)
 * and structured log events. All instrumentation is gated on `OPENCODE_ENABLE_TELEMETRY`.
 */
export const OtelPlugin: Plugin = async ({ project, client }) => {
  const config = loadConfig()
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
  })

  await log("debug", "config loaded", {
    headersSet: !!config.otlpHeaders,
    resourceAttributesSet: !!config.resourceAttributes,
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

  const { meterProvider, loggerProvider, tracerProvider } = setupOtel(
    config.endpoint,
    config.protocol,
    config.metricsInterval,
    config.logsInterval,
    PLUGIN_VERSION,
  )
  await log("info", "OTel SDK initialized")

  const instruments = createInstruments(config.metricPrefix)
  const logger = logs.getLogger("com.opencode")
  const tracer = trace.getTracer("com.opencode")
  const pendingToolSpans = new Map()
  const pendingPermissions = new Map()
  const sessionTotals = new Map()
  const sessionSpans = new Map()
  const messageSpans = new Map()
  const { disabledMetrics, disabledTraces } = config
  const commonAttrs = { "project.id": project.id } as const

  if (disabledMetrics.size > 0) {
    await log("info", "metrics disabled", { disabled: [...disabledMetrics] })
  }

  if (disabledTraces.size > 0) {
    await log("info", "traces disabled", { disabled: [...disabledTraces] })
  }

  const ctx: HandlerContext = {
    logger,
    log,
    instruments,
    commonAttrs,
    pendingToolSpans,
    pendingPermissions,
    sessionTotals,
    disabledMetrics,
    disabledTraces,
    tracer,
    tracePrefix: config.metricPrefix,
    sessionSpans,
    messageSpans,
  }

  async function shutdown() {
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

    "chat.message": safe("chat.message", async (input, output) => {
      const agent = input.agent ?? "unknown"
      const totals = sessionTotals.get(input.sessionID)
      if (totals) totals.agent = agent
      const promptLength = output.parts.reduce(
        (acc, p) => (p.type === "text" ? acc + p.text.length : acc),
        0,
      )
      logger.emit({
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
        timestamp: Date.now(),
        observedTimestamp: Date.now(),
        body: "user_prompt",
        attributes: {
          "event.name": "user_prompt",
          "session.id": input.sessionID,
          agent,
          prompt_length: promptLength,
          model: input.model
            ? `${input.model.providerID}/${input.model.modelID}`
            : "unknown",
          ...commonAttrs,
        },
      })
    }),

    event: safe("event", async ({ event }) => {
      switch (event.type) {
        case "session.created":
          await handleSessionCreated(event as EventSessionCreated, ctx)
          break
        case "session.idle":
          handleSessionIdle(event as EventSessionIdle, ctx)
          break
        case "session.error":
          handleSessionError(event as EventSessionError, ctx)
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
          if (info.role === "assistant" && !info.time?.completed) {
            startMessageSpan(
              info.sessionID,
              info.id,
              info.modelID ?? "unknown",
              info.providerID ?? "unknown",
              info.time?.created ?? Date.now(),
              ctx,
            )
          }
          await handleMessageUpdated(msgEvt, ctx)
          break
        }
        case "message.part.updated":
          await handleMessagePartUpdated(event as EventMessagePartUpdated, ctx)
          break
      }
    }),
  }
}
