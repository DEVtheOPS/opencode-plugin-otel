import type { Context, Counter, Gauge, Histogram, Span, Tracer } from "@opentelemetry/api"
import type { LogRecord } from "@opentelemetry/api-logs"

/** Numeric priority map for log levels; higher value = higher severity. */
export const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const

/** Union of supported log level names. */
export type Level = keyof typeof LEVELS

/** Maximum number of entries kept in `pendingToolSpans` and `pendingPermissions` maps. */
export const MAX_PENDING = 500

/** Structured logger forwarded to the opencode `client.app.log` API. */
export type PluginLogger = (
  level: Level,
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>

/** OTel resource attributes common to every emitted log and metric. */
export type CommonAttrs = { readonly "project.id": string }

/** Severity numbers supplied by the plugin entrypoint so handlers do not import log globals. */
export type LogSeverity = {
  info: NonNullable<LogRecord["severityNumber"]>
  error: NonNullable<LogRecord["severityNumber"]>
}

/** In-flight tool execution tracked between `running` and `completed`/`error` part updates. */
export type PendingToolSpan = {
  tool: string
  sessionID: string
  startMs: number
  span?: Span
}

/** Permission prompt tracked between `permission.updated` and `permission.replied`. */
export type PendingPermission = {
  type: string
  title: string
  sessionID: string
}

/** OTel metric instruments created once at plugin startup and shared via `HandlerContext`. */
export type Instruments = {
  sessionCounter: Counter
  tokenCounter: Counter
  costCounter: Counter
  linesCounter: Counter
  linesTotalGauge: Gauge
  commitCounter: Counter
  toolDurationHistogram: Histogram
  cacheCounter: Counter
  sessionDurationHistogram: Histogram
  messageCounter: Counter
  sessionTokenGauge: Histogram
  sessionCostGauge: Histogram
  modelUsageCounter: Counter
  retryCounter: Counter
  subtaskCounter: Counter
  skillCounter: Counter
}

/** Accumulated per-session totals used for gauge snapshots on session.idle. */
export type SessionTotals = {
  startMs: number
  tokens: number
  cost: number
  messages: number
  agent: string
}

/** Shared context threaded through every event handler. */
export type HandlerContext = {
  log: PluginLogger
  emitLog: (record: LogRecord) => void
  logSeverity: LogSeverity
  instruments: Instruments
  commonAttrs: CommonAttrs
  pendingToolSpans: Map<string, PendingToolSpan>
  pendingPermissions: Map<string, PendingPermission>
  sessionTotals: Map<string, SessionTotals>
  sessionDiffTotals: Map<string, { additions: number; deletions: number }>
  disabledMetrics: Set<string>
  disabledTraces: Set<string>
  tracer: Tracer
  tracePrefix: string
  rootContext: () => Context
  sessionSpans: Map<string, Span>
  messageSpans: Map<string, Span>
  sessionInputs: Map<string, string>
  messageOutputs: Map<string, string>
}
