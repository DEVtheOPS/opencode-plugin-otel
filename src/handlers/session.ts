import { SeverityNumber } from "@opentelemetry/api-logs"
import type { EventSessionCreated, EventSessionIdle, EventSessionError, EventSessionStatus } from "@opencode-ai/sdk"
import { errorSummary, setBoundedMap, isMetricEnabled } from "../util.ts"
import type { HandlerContext } from "../types.ts"

/** Increments the session counter, records start time, and emits a `session.created` log event. */
export function handleSessionCreated(e: EventSessionCreated, ctx: HandlerContext) {
  const { id: sessionID, time, parentID } = e.properties.info
  const createdAt = time.created
  const isSubagent = !!parentID
  if (isMetricEnabled("session.count", ctx)) {
    ctx.instruments.sessionCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, is_subagent: isSubagent })
  }
  setBoundedMap(ctx.sessionTotals, sessionID, { startMs: createdAt, tokens: 0, cost: 0, messages: 0, agent: "unknown" })
  ctx.logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: createdAt,
    observedTimestamp: Date.now(),
    body: "session.created",
    attributes: { "event.name": "session.created", "session.id": sessionID, is_subagent: isSubagent, ...ctx.commonAttrs },
  })
  return ctx.log("info", "otel: session.created", { sessionID, createdAt, isSubagent })
}

function sweepSession(sessionID: string, ctx: HandlerContext) {
  for (const [id, perm] of ctx.pendingPermissions) {
    if (perm.sessionID === sessionID) ctx.pendingPermissions.delete(id)
  }
  for (const [key, span] of ctx.pendingToolSpans) {
    if (span.sessionID === sessionID) ctx.pendingToolSpans.delete(key)
  }
}

/** Emits a `session.idle` log event, records duration and session total histograms, and clears pending state. */
export function handleSessionIdle(e: EventSessionIdle, ctx: HandlerContext) {
  const sessionID = e.properties.sessionID
  const totals = ctx.sessionTotals.get(sessionID)
  ctx.sessionTotals.delete(sessionID)
  sweepSession(sessionID, ctx)

  const attrs = { ...ctx.commonAttrs, "session.id": sessionID }
  let duration_ms: number | undefined

  if (totals) {
    duration_ms = Date.now() - totals.startMs
    if (isMetricEnabled("session.duration", ctx)) {
      ctx.instruments.sessionDurationHistogram.record(duration_ms, attrs)
    }
    if (isMetricEnabled("session.token.total", ctx)) {
      ctx.instruments.sessionTokenGauge.record(totals.tokens, attrs)
    }
    if (isMetricEnabled("session.cost.total", ctx)) {
      ctx.instruments.sessionCostGauge.record(totals.cost, attrs)
    }
  }

  ctx.logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: "session.idle",
    attributes: {
      "event.name": "session.idle",
      "session.id": sessionID,
      total_tokens: totals?.tokens ?? 0,
      total_cost_usd: totals?.cost ?? 0,
      total_messages: totals?.messages ?? 0,
      ...ctx.commonAttrs,
    },
  })
  ctx.log("debug", "otel: session.idle", {
    sessionID,
    ...(totals ? { duration_ms, total_tokens: totals.tokens, total_cost_usd: totals.cost, total_messages: totals.messages } : {}),
  })
}

/** Emits a `session.error` log event and clears any pending tool spans and permissions for the session. */
export function handleSessionError(e: EventSessionError, ctx: HandlerContext) {
  const rawID = e.properties.sessionID
  const sessionID = rawID ?? "unknown"
  const error = errorSummary(e.properties.error)
  if (rawID) ctx.sessionTotals.delete(rawID)
  sweepSession(sessionID, ctx)
  ctx.logger.emit({
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: "session.error",
    attributes: {
      "event.name": "session.error",
      "session.id": sessionID,
      error,
      ...ctx.commonAttrs,
    },
  })
  ctx.log("error", "otel: session.error", { sessionID, error })
}

/** Increments the retry counter when the session enters a retry state. */
export function handleSessionStatus(e: EventSessionStatus, ctx: HandlerContext) {
  if (e.properties.status.type !== "retry") return
  const { sessionID, status } = e.properties
  const { attempt, message: retryMessage } = status
  if (isMetricEnabled("retry.count", ctx)) {
    ctx.instruments.retryCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID })
    ctx.log("debug", "otel: retry counter incremented", { sessionID, attempt, retryMessage })
  }
}
