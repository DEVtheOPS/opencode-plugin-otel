import { trace } from "@opentelemetry/api"
import { MAX_PENDING } from "./types.ts"
import type { HandlerContext, SessionAgentType } from "./types.ts"

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

/** Returns a human-readable summary string from an opencode error object. */
export function errorSummary(err: { name: string; data?: unknown } | undefined): string {
  if (!err) return "unknown"
  if (err.data && typeof err.data === "object" && "message" in err.data) {
    return `${err.name}: ${(err.data as { message: string }).message}`
  }
  return err.name
}

/** Returns the canonical OTel GenAI provider name, preserving unknown provider IDs. */
export function genAiProviderName(providerID: string): string {
  return GEN_AI_PROVIDER_NAMES[providerID] ?? providerID
}

/**
 * Inserts a key/value pair into `map`, evicting the oldest entry first when the map
 * has reached `MAX_PENDING` capacity to prevent unbounded memory growth.
 */
export function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V) {
  if (map.size >= MAX_PENDING) {
    const [firstKey] = map.keys()
    if (firstKey !== undefined) map.delete(firstKey)
  }
  map.set(key, value)
}

/** Resolves a root-run context from the live span first, then from the retained ended span context. */
export function resolveRunTraceContext(runID: string, ctx: Pick<HandlerContext, "rootContext" | "runSpans" | "runSpanContexts">) {
  const baseCtx = ctx.rootContext()
  const runSpan = ctx.runSpans.get(runID)
  if (runSpan) return trace.setSpan(baseCtx, runSpan)
  const runSpanContext = ctx.runSpanContexts.get(runID)
  return runSpanContext ? trace.setSpanContext(baseCtx, runSpanContext) : baseCtx
}

/** Resolves the best available trace parent for a session event or message/tool child span. */
export function resolveSessionTraceContext(
  sessionID: string,
  ctx: HandlerContext,
  input?: { assistantMessageID?: string; runID?: string },
) {
  const baseCtx = ctx.rootContext()
  const sessionSpan = ctx.sessionSpans.get(sessionID)
  if (sessionSpan) return trace.setSpan(baseCtx, sessionSpan)
  const sessionSpanContext = ctx.sessionSpanContexts.get(sessionID)
  if (sessionSpanContext) return trace.setSpanContext(baseCtx, sessionSpanContext)
  if (input?.runID) return resolveRunTraceContext(input.runID, ctx)
  const assistantRunID = input?.assistantMessageID
    ? ctx.assistantRuns.get(input.assistantMessageID)
    : undefined
  if (assistantRunID) return resolveRunTraceContext(assistantRunID, ctx)
  const activeRunID = ctx.activeRuns.get(sessionID)
  return activeRunID ? resolveRunTraceContext(activeRunID, ctx) : baseCtx
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

/**
 * Accumulates token and cost totals for a session, and increments the message count.
 * Uses `setBoundedMap` to produce a new object rather than mutating in-place.
 * No-ops silently if the session was not previously registered via `handleSessionCreated`.
 */
export function accumulateSessionTotals(
  sessionID: string,
  tokens: number,
  cost: number,
  ctx: HandlerContext,
) {
  const existing = ctx.sessionTotals.get(sessionID)
  if (!existing) return
  setBoundedMap(ctx.sessionTotals, sessionID, {
    startMs: existing.startMs,
    tokens: existing.tokens + tokens,
    cost: existing.cost + cost,
    messages: existing.messages + 1,
    agent: existing.agent,
    agentType: existing.agentType,
  })
}

/** Returns the current session-scoped agent name/type, defaulting to `unknown` when unavailable. */
export function getSessionAgentMeta(
  sessionID: string,
  ctx: Pick<HandlerContext, "sessionTotals">,
): { agentName: string; agentType: SessionAgentType | "unknown" } {
  const totals = ctx.sessionTotals.get(sessionID)
  return {
    agentName: totals?.agent ?? "unknown",
    agentType: totals?.agentType ?? "unknown",
  }
}

/** Builds a consistent agent attribute set for OTLP logs, metrics, and spans. */
export function agentAttrs(agentName: string, agentType: SessionAgentType | "unknown") {
  return {
    agent: agentName,
    "agent.name": agentName,
    "agent.type": agentType,
  } as const
}
