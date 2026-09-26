import { trace, type Context } from "@opentelemetry/api"
import { MAX_PENDING, type HandlerContext, type SessionAgentType, type TracingState } from "./types.ts"

const MAX_SEEN_EVENTS = 10_000

const GEN_AI_PROVIDER_NAMES: Readonly<Record<string, string>> = {
  "amazon-bedrock": "aws.bedrock",
  azure: "azure.ai.openai",
  "azure-cognitive-services": "azure.ai.openai",
  google: "gcp.gemini",
  "google-vertex": "gcp.vertex_ai",
  "google-vertex-anthropic": "gcp.vertex_ai",
  mistral: "mistral_ai",
  xai: "x_ai",
}

/** A structured error as emitted by the OpenCode V2 event stream. */
export type StructuredError = { type: string; message: string; status?: number }

/** Token counts as emitted by the OpenCode V2 event stream. */
export type TokenInfo = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

/** A `{ providerID, id }` model reference as emitted by the OpenCode V2 event stream. */
export type ModelRef = { providerID: string; id: string; variant?: string }

/** Returns a human-readable summary string from a structured error payload. */
export function errorSummary(err: StructuredError | undefined): string {
  if (!err) return "unknown"
  return `${err.type}: ${err.message}`
}

/** Returns the canonical OTel GenAI provider name, preserving unknown provider IDs. */
export function genAiProviderName(providerID: string): string {
  return GEN_AI_PROVIDER_NAMES[providerID] ?? providerID
}

/** Sums billed tokens for a usage sample, excluding cache reads/writes. */
export function totalTokens(tokens: TokenInfo | undefined): number {
  if (!tokens) return 0
  return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0)
}

/** Formats a model reference as `provider/id`, defaulting to `unknown`. */
export function modelRef(model: ModelRef | undefined): string {
  return model ? `${model.providerID}/${model.id}` : "unknown"
}

/**
 * Inserts a key/value pair into `map`, evicting the oldest entry first when the map
 * has reached `MAX_PENDING` capacity to prevent unbounded memory growth.
 */
export function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V) {
  if (!map.has(key) && map.size >= MAX_PENDING) {
    const [firstKey] = map.keys()
    if (firstKey !== undefined) map.delete(firstKey)
  }
  map.set(key, value)
}

/** Records an event id for de-duplication, evicting the oldest entry when at capacity. */
export function markSeen(seen: TracingState["seenEvents"], id: string): void {
  if (!seen.has(id) && seen.size >= MAX_SEEN_EVENTS) {
    const [first] = seen.values()
    if (first !== undefined) seen.delete(first)
  }
  seen.add(id)
}

export function enqueueEvent(state: TracingState, id: string, handle: () => Promise<void>): Promise<void> {
  const task = state.eventQueue.then(async () => {
    if (state.seenEvents.has(id)) return
    await handle()
    markSeen(state.seenEvents, id)
  })
  state.eventQueue = task.catch(() => {})
  return task
}

/** Enqueues subscription events without blocking the reader while preserving shared dispatch order. */
export async function consumeEvents<T extends { id: string }>(
  events: AsyncIterable<T>,
  state: TracingState,
  dispatch: (event: T) => Promise<void>,
  onError: (event: T, error: unknown) => Promise<void>,
): Promise<void> {
  let last = Promise.resolve()
  try {
    for await (const event of events) {
      last = enqueueEvent(state, event.id, () => dispatch(event)).catch((error) => onError(event, error))
    }
  } finally {
    await last
  }
}

/**
 * Returns `true` if the metric name (without prefix) is not in the disabled set.
 * The `name` should be the suffix after the metric prefix, e.g. `"session.count"`.
 */
export function isMetricEnabled(name: string, ctx: { disabledMetrics: Set<string> }): boolean {
  return !ctx.disabledMetrics.has(name)
}

/**
 * Returns `true` if the trace type is not in the disabled set.
 * Valid names are `"session"`, `"llm"`, and `"tool"`.
 */
export function isTraceEnabled(name: string, ctx: { disabledTraces: Set<string> }): boolean {
  return !ctx.disabledTraces.has(name)
}

/** Builds a consistent agent attribute set for OTLP logs, metrics, and spans. */
export function agentAttrs(agentName: string, agentType: SessionAgentType | "unknown") {
  return {
    agent: agentName,
    "agent.name": agentName,
    "agent.type": agentType,
  } as const
}

/** Resolves the trace context for a run span, falling back to the configured root context. */
export function resolveRunContext(sessionID: string, ctx: HandlerContext): Context {
  const base = ctx.rootContext()
  const span = ctx.tracing.runSpans.get(sessionID)
  if (span) return trace.setSpan(base, span)
  const spanContext = ctx.tracing.runSpanContexts.get(sessionID)
  return spanContext ? trace.setSpanContext(base, spanContext) : base
}

/** Resolves the trace context for a step span, falling back to its run context. */
export function resolveStepContext(sessionID: string, assistantMessageID: string, ctx: HandlerContext): Context {
  const parent = resolveRunContext(sessionID, ctx)
  const span = ctx.tracing.stepSpans.get(assistantMessageID)
  if (span) return trace.setSpan(parent, span)
  const spanContext = ctx.tracing.stepSpanContexts.get(assistantMessageID)
  return spanContext ? trace.setSpanContext(parent, spanContext) : parent
}

/** Resolves a child run under its correlated dispatch tool, falling back to the parent run. */
export function resolveSubagentTraceContext(sessionID: string, parentID: string, agent: string, ctx: HandlerContext): Context {
  const exact = ctx.tracing.subagentParents.get(sessionID)
  if (exact) return trace.setSpanContext(ctx.rootContext(), exact)
  const candidates = [...ctx.tracing.toolMeta]
    .filter(([id, meta]) => meta.sessionID === parentID && meta.tool === "subagent"
      && (!meta.childSessionID || meta.childSessionID === sessionID)
      && (!meta.agent || agent === "unknown" || meta.agent === agent) && ctx.tracing.toolSpans.has(id))
  if (candidates.length === 1) {
    const span = ctx.tracing.toolSpans.get(candidates[0]![0])!
    return trace.setSpan(ctx.rootContext(), span)
  }
  return resolveRunContext(parentID, ctx)
}

/** Resolves the current session-scoped agent name/type, defaulting to `unknown` when unavailable. */
export function getSessionAgentMeta(
  sessionID: string,
  ctx: HandlerContext,
): { agentName: string; agentType: SessionAgentType | "unknown" } {
  const totals = ctx.tracing.sessionTotals.get(sessionID)
  return {
    agentName: totals?.agent ?? "unknown",
    agentType: totals?.agentType ?? "unknown",
  }
}

export async function contextForSession(
  sessionID: string,
  ctx: HandlerContext,
  getSession: (sessionID: string) => Promise<{ projectID: string; agent?: string; parentID?: string; time: { created: number } }>,
): Promise<HandlerContext> {
  let projectID = ctx.tracing.sessionProjects.get(sessionID)
  if (!projectID || !ctx.tracing.sessionIdentity.has(sessionID)) {
    try {
      const session = await getSession(sessionID)
      projectID = session.projectID
      setBoundedMap(ctx.tracing.sessionProjects, sessionID, projectID)
      setBoundedMap(ctx.tracing.sessionIdentity, sessionID, {
        agent: session.agent ?? "unknown",
        agentType: session.parentID ? "subagent" : "primary",
        ...(session.parentID ? { parentID: session.parentID } : {}),
        startMs: session.time.created,
      })
    } catch {
      if (!projectID) return ctx
    }
  }
  return projectID ? { ...ctx, commonAttrs: { ...ctx.commonAttrs, "project.id": projectID } } : ctx
}
