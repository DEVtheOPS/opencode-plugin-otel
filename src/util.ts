import { ROOT_CONTEXT, trace } from "@opentelemetry/api"
import { MAX_PENDING } from "./types.ts"
import type { HandlerContext } from "./types.ts"

/** Returns a human-readable summary string from an opencode error object. */
export function errorSummary(err: { name: string; data?: unknown } | undefined): string {
  if (!err) return "unknown"
  if (err.data && typeof err.data === "object" && "message" in err.data) {
    return `${err.name}: ${(err.data as { message: string }).message}`
  }
  return err.name
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

export function resolveSessionTraceContext(sessionID: string, ctx: HandlerContext) {
  const parentContext = ctx.parentContext ?? ROOT_CONTEXT
  const sessionSpan = ctx.sessionSpans.get(sessionID)
  if (sessionSpan) return trace.setSpan(parentContext, sessionSpan)
  const spanContext = ctx.sessionSpanContexts.get(sessionID)
  if (spanContext) return trace.setSpanContext(parentContext, spanContext)
  const runRootID = ctx.sessionRunRoots.get(sessionID)
  const runSpanContext = runRootID ? ctx.runSpanContexts.get(runRootID) : undefined
  return runSpanContext ? trace.setSpanContext(parentContext, runSpanContext) : undefined
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
  })
}
