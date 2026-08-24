import type { Context, Counter, Gauge, Histogram, Span, SpanContext, Tracer } from "@opentelemetry/api"
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

/** OTel attributes common to every emitted span, log, and metric. */
export type CommonAttrs = Readonly<Record<string, string>>

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
}

/** Session role emitted by opencode: either the primary/root agent or a spawned subagent. */
export type SessionAgentType = "primary" | "subagent"

/** Accumulated per-session totals used for gauge snapshots on session.idle. */
export type SessionTotals = {
  startMs: number
  tokens: number
  cost: number
  messages: number
  agent: string
  agentType: SessionAgentType
}

/** Pending root-run metadata captured from `chat.message` until the user message ID is known. */
export type PendingRun = {
  agent: string
  promptText: string
  model: string
  startTime: number
}

/** Live LLM request span metadata used by the outbound header hook. */
export type LlmRequestContext = {
  messageID: string
  agent: string
  modelID: string
  providerID: string
  spanContext: SpanContext
}

/** Shared context threaded through every event handler. */
export type HandlerContext = {
  log: PluginLogger
  emitLog: (record: LogRecord) => void
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
  runSpans: Map<string, Span>
  runSpanContexts: Map<string, SpanContext>
  activeRuns: Map<string, string>
  assistantRuns: Map<string, string>
  pendingRuns: Map<string, PendingRun>
  runInputs: Map<string, string>
  sessionTitles: Map<string, string>
  sessionSpans: Map<string, Span>
  sessionSpanContexts: Map<string, SpanContext>
  messageSpans: Map<string, Span>
  messageOutputs: Map<string, string>
  llmRequestContexts: Map<string, LlmRequestContext[]>
  tracePropagationProviders: Set<string>
}
