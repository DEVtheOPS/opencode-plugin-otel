import type { Context, Counter, Histogram, Span, SpanContext, Tracer } from "@opentelemetry/api"
import type { LogRecord, Logger } from "@opentelemetry/api-logs"
import type { Plugin } from "@opencode/plugin"
import type { OtelProviders } from "./otel.ts"

/** Numeric priority map for log levels; higher value = higher severity. */
export const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const

/** Union of supported log level names. */
export type Level = keyof typeof LEVELS

/** Maximum number of entries kept in bounded correlation maps. */
export const MAX_PENDING = 500

/** Maximum number of event ids retained for cross-instance de-duplication. */
export const MAX_SEEN_EVENTS = 10_000

/** The OpenCode V2 plugin context passed to `setup`. */
export type OpenCodeContext = Plugin.Context

type SubscribeResult = ReturnType<OpenCodeContext["event"]["subscribe"]>

/** A single OpenCode V2 server event, as yielded by `ctx.event.subscribe()`. */
export type OpenCodeEvent = SubscribeResult extends AsyncIterable<infer E> ? E : never

/** Narrows {@link OpenCodeEvent} to a single `type` discriminant. */
export type EventOf<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { type: T }>

/** Structured logger for plugin diagnostics, forwarded to the server console. */
export type PluginLogger = (
  level: Level,
  message: string,
  extra?: Record<string, unknown>,
) => Promise<void>

/** OTel attributes common to every emitted span, log, and metric. */
export type CommonAttrs = Readonly<Record<string, string>>

/** In-flight permission prompt tracked between `permission.asked` and `permission.replied`. */
export type PendingPermission = {
  action: string
  resources: string[]
  sessionID: string
}

/** Prompt text captured on the `prompt` hook and attached to the next run span. */
export type PendingPrompt = {
  text: string
  startMs: number
}

/** OTel metric instruments created once at plugin startup and shared via `HandlerContext`. */
export type Instruments = {
  sessionCounter: Counter
  tokenCounter: Counter
  costCounter: Counter
  commitCounter: Counter
  toolDurationHistogram: Histogram
  cacheCounter: Counter
  sessionDurationHistogram: Histogram
  messageCounter: Counter
  sessionTokenHistogram: Histogram
  sessionCostHistogram: Histogram
  modelUsageCounter: Counter
  retryCounter: Counter
  subtaskCounter: Counter
}

/** Session role emitted by opencode: either the primary/root agent or a spawned subagent. */
export type SessionAgentType = "primary" | "subagent"

/** Accumulated per-session totals used for gauge snapshots at execution end. */
export type SessionTotals = {
  startMs: number
  tokens: number
  cost: number
  messages: number
  agent: string
  agentType: SessionAgentType
  parentID?: string
}

export type SessionIdentity = {
  agent: string
  agentType: SessionAgentType
  parentID?: string
  startMs: number
}

/** Model/agent metadata for an in-flight LLM step, keyed by assistant message ID. */
export type StepMeta = {
  sessionID: string
  agent: string
  agentType: SessionAgentType | "unknown"
  modelID: string
  providerID: string
}

/** Metadata for an in-flight tool call keyed by tool call id. */
export type ToolMeta = {
  sessionID: string
  assistantMessageID: string
  tool: string
  startMs: number
  command?: string
}

/** Live LLM request metadata used by the `model.request` trace-propagation hook. */
export type LlmRequestContext = {
  agent: string
  modelID: string
  providerID: string
  spanContext: SpanContext
}

/**
 * Per-process shared OTel SDK instance. OpenCode loads a plugin instance per
 * location but the OTel global providers may only be registered once, so the
 * providers, instruments, logger, and tracer are shared via `globalThis`.
 */
export type SharedOtel = {
  providers: OtelProviders
  instruments: Instruments
  logger: Logger
  tracer: Tracer
  refs: number
  configKey: string
}

/**
 * Per-process tracing correlation state. Span ids are unique across the
 * process, so a single shared state keeps parent lookups consistent when
 * multiple plugin instances observe the same stream.
 */
export type TracingState = {
  seenEvents: Set<string>
  eventQueue: Promise<void>
  runSpans: Map<string, Span>
  runSpanContexts: Map<string, SpanContext>
  stepSpans: Map<string, Span>
  stepSpanContexts: Map<string, SpanContext>
  toolSpans: Map<string, Span>
  toolSpanContexts: Map<string, SpanContext>
  toolMeta: Map<string, ToolMeta>
  stepMeta: Map<string, StepMeta>
  sessionTotals: Map<string, SessionTotals>
  countedSessions: Set<string>
  countedMessages: Set<string>
  sessionProjects: Map<string, string>
  sessionIdentity: Map<string, SessionIdentity>
  stepOutputs: Map<string, Map<number, string>>
  pendingPrompts: Map<string, PendingPrompt>
  pendingPermissions: Map<string, PendingPermission>
  activeLlm: Map<string, LlmRequestContext>
}

/** Shared context threaded through every event handler. */
export type HandlerContext = {
  log: PluginLogger
  emitLog: (record: LogRecord) => void
  instruments: Instruments
  commonAttrs: CommonAttrs
  disabledMetrics: Set<string>
  disabledTraces: Set<string>
  tracer: Tracer
  tracePrefix: string
  rootContext: () => Context
  tracing: TracingState
  tracePropagationProviders: Set<string>
}
