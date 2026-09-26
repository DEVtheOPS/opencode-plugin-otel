import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanStatusCode } from "@opentelemetry/api"
import {
  AGENT_NAME,
  INPUT_MIME_TYPE,
  INPUT_VALUE,
  LLM_INPUT_MESSAGES,
  MimeType,
  OpenInferenceSpanKind,
  SemanticConventions,
  SESSION_ID,
} from "@arizeai/openinference-semantic-conventions"
import type { EventOf, HandlerContext, SessionAgentType, SessionTotals } from "../types.ts"
import {
  agentAttrs,
  errorSummary,
  isMetricEnabled,
  isTraceEnabled,
  modelRef,
  resolveRunContext,
  setBoundedMap,
  totalTokens,
} from "../util.ts"

const OPENINFERENCE_SPAN_KIND = SemanticConventions.OPENINFERENCE_SPAN_KIND

function countSession(sessionID: string, isSubagent: boolean, ctx: HandlerContext) {
  if (ctx.tracing.countedSessions.has(sessionID)) return
  ctx.tracing.countedSessions.add(sessionID)
  if (isMetricEnabled("session.count", ctx)) {
    ctx.instruments.sessionCounter.add(1, {
      ...ctx.commonAttrs,
      "session.id": sessionID,
      is_subagent: isSubagent,
    })
  }
}

/**
 * Ensures session totals exist for a session id. OpenCode does not replay durable
 * events, so a session created before the plugin subscribed (for example a
 * pre-existing session resumed with `opencode run`) never emits `session.created`;
 * the first event we observe for it initializes and counts the session lazily.
 */
export function ensureSession(sessionID: string, at: number, ctx: HandlerContext): SessionTotals {
  const existing = ctx.tracing.sessionTotals.get(sessionID)
  if (existing) return existing
  countSession(sessionID, false, ctx)
  const totals: SessionTotals = {
    startMs: at,
    tokens: 0,
    cost: 0,
    messages: 0,
    agent: "unknown",
    agentType: "primary",
  }
  setBoundedMap(ctx.tracing.sessionTotals, sessionID, totals)
  return totals
}

/** Increments the session counter, records totals, and emits a `session.created` log event. */
export function handleSessionCreated(e: EventOf<"session.created">, ctx: HandlerContext) {
  const d = e.data
  const isSubagent = !!d.parentID
  const agentType: SessionAgentType = isSubagent ? "subagent" : "primary"
  const agent = d.agent ?? "unknown"

  countSession(d.sessionID, isSubagent, ctx)
  if (isSubagent && isMetricEnabled("subtask.count", ctx)) {
    ctx.instruments.subtaskCounter.add(1, {
      ...ctx.commonAttrs,
      "session.id": d.sessionID,
      "agent.type": "subagent",
    })
  }

  setBoundedMap(ctx.tracing.sessionTotals, d.sessionID, {
    startMs: e.created,
    tokens: ctx.tracing.sessionTotals.get(d.sessionID)?.tokens ?? 0,
    cost: ctx.tracing.sessionTotals.get(d.sessionID)?.cost ?? 0,
    messages: ctx.tracing.sessionTotals.get(d.sessionID)?.messages ?? 0,
    agent,
    agentType,
    ...(d.parentID ? { parentID: d.parentID } : {}),
  })

  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: e.created,
    observedTimestamp: Date.now(),
    body: "session.created",
    attributes: {
      "event.name": "session.created",
      "session.id": d.sessionID,
      is_subagent: isSubagent,
      ...agentAttrs(agent, agentType),
      ...(d.model ? { model: modelRef(d.model) } : {}),
      ...ctx.commonAttrs,
    },
  })
  void ctx.log("info", "otel: session.created", { sessionID: d.sessionID, isSubagent })
}

/** Starts the root run span for a single execution (user turn), keyed by session id. */
export function handleExecutionStarted(e: EventOf<"session.execution.started">, ctx: HandlerContext) {
  const sessionID = e.data.sessionID
  const totals = ensureSession(sessionID, e.created, ctx)
  const pendingPrompt = ctx.tracing.pendingPrompts.get(sessionID)

  if (!isTraceEnabled("session", ctx)) return

  const isSubagent = totals?.agentType === "subagent"
  const parentCtx = isSubagent && totals?.parentID
    ? resolveRunContext(totals.parentID, ctx)
    : ctx.rootContext()
  const promptText = pendingPrompt?.text ?? ""

  const span = ctx.tracer.startSpan(
    `${ctx.tracePrefix}session`,
    {
      startTime: e.created,
      attributes: {
        [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
        [SESSION_ID]: sessionID,
        [AGENT_NAME]: totals?.agent ?? "unknown",
        "agent.type": totals?.agentType ?? "primary",
        "session.is_subagent": isSubagent,
        ...(promptText
          ? {
              [INPUT_VALUE]: promptText,
              [INPUT_MIME_TYPE]: MimeType.TEXT,
              [LLM_INPUT_MESSAGES]: JSON.stringify([{ role: "user", content: promptText }]),
            }
          : {}),
        ...ctx.commonAttrs,
      },
    },
    parentCtx,
  )
  setBoundedMap(ctx.tracing.runSpans, sessionID, span)
  setBoundedMap(ctx.tracing.runSpanContexts, sessionID, span.spanContext())
}

/** Terminal execution events that end the root run span. */
export type ExecutionOutcome =
  | { type: "succeeded" }
  | { type: "failed"; error: { type: string; message: string; status?: number } }
  | { type: "interrupted"; reason: string }

/**
 * Ends the root run span for an execution with the given outcome and emits a
 * `session.error` log event when the execution failed.
 */
export function handleExecutionEnded(
  e: EventOf<"session.execution.succeeded"> | EventOf<"session.execution.failed"> | EventOf<"session.execution.interrupted">,
  ctx: HandlerContext,
  outcome: ExecutionOutcome,
) {
  const sessionID = e.data.sessionID
  const totals = ctx.tracing.sessionTotals.get(sessionID)

  sweepExecution(sessionID, ctx)

  const span = ctx.tracing.runSpans.get(sessionID)
  if (span) {
    if (totals) {
      span.setAttributes({
        [AGENT_NAME]: totals.agent,
        "agent.type": totals.agentType,
        "session.total_tokens": totals.tokens,
        "session.total_cost_usd": totals.cost,
        "session.total_messages": totals.messages,
      })
    }
    if (outcome.type === "failed") {
      const message = errorSummary(outcome.error)
      span.setStatus({ code: SpanStatusCode.ERROR, message })
      span.setAttribute("error", message)
    } else if (outcome.type === "interrupted") {
      span.setAttribute("session.interrupted_reason", outcome.reason)
      span.setStatus({ code: SpanStatusCode.OK })
    } else {
      span.setStatus({ code: SpanStatusCode.OK })
    }
    span.end(e.created)
    ctx.tracing.runSpans.delete(sessionID)
    ctx.tracing.runSpanContexts.delete(sessionID)
  }

  if (outcome.type === "failed") {
    const message = errorSummary(outcome.error)
    ctx.emitLog({
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
      timestamp: e.created,
      observedTimestamp: Date.now(),
      body: "session.error",
      attributes: {
        "event.name": "session.error",
        "session.id": sessionID,
        error: message,
        ...agentAttrs(totals?.agent ?? "unknown", totals?.agentType ?? "unknown"),
        ...ctx.commonAttrs,
      },
    })
    void ctx.log("error", "otel: session.error", { sessionID, error: message })
  }
}

/** Handles `session.status`: counts retries and finalizes the session on idle. */
export function handleSessionStatus(e: EventOf<"session.status">, ctx: HandlerContext) {
  const { sessionID, status } = e.data
  if (status.type === "retry") {
    if (isMetricEnabled("retry.count", ctx)) {
      ctx.instruments.retryCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID })
    }
    void ctx.log("debug", "otel: retry scheduled", { sessionID, attempt: status.attempt })
    return
  }
  if (status.type === "idle") finalizeSession(sessionID, ctx)
}

/** Handles the deprecated `session.idle` event as an idle finalization signal. */
export function handleSessionIdle(e: EventOf<"session.idle">, ctx: HandlerContext) {
  finalizeSession(e.data.sessionID, ctx)
}

/**
 * Updates the running session totals from the authoritative cumulative usage
 * sample emitted by opencode after each step.
 */
export function handleUsageUpdated(e: EventOf<"session.usage.updated">, ctx: HandlerContext) {
  const { sessionID, cost, tokens } = e.data
  const existing = ensureSession(sessionID, e.created, ctx)
  const next: SessionTotals = {
    ...existing,
    tokens: totalTokens(tokens) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0),
    cost,
  }
  setBoundedMap(ctx.tracing.sessionTotals, sessionID, next)
}

/**
 * Records session duration and total token/cost histograms and emits a
 * `session.idle` log, then clears per-session state. No-ops when the session
 * totals were already finalized, so a status-idle followed by a deprecated
 * idle event does not double count.
 */
export function finalizeSession(sessionID: string, ctx: HandlerContext) {
  const totals = ctx.tracing.sessionTotals.get(sessionID)
  if (!totals) {
    sweepExecution(sessionID, ctx)
    return
  }
  ctx.tracing.sessionTotals.delete(sessionID)
  ctx.tracing.activeLlm.delete(sessionID)
  ctx.tracing.pendingPrompts.delete(sessionID)

  const attrs = { ...ctx.commonAttrs, "session.id": sessionID }
  const durationMs = Date.now() - totals.startMs
  if (isMetricEnabled("session.duration", ctx)) {
    ctx.instruments.sessionDurationHistogram.record(durationMs, attrs)
  }
  if (isMetricEnabled("session.token.total", ctx)) {
    ctx.instruments.sessionTokenHistogram.record(totals.tokens, attrs)
  }
  if (isMetricEnabled("session.cost.total", ctx)) {
    ctx.instruments.sessionCostHistogram.record(totals.cost, attrs)
  }

  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: "session.idle",
    attributes: {
      "event.name": "session.idle",
      "session.id": sessionID,
      total_tokens: totals.tokens,
      total_cost_usd: totals.cost,
      total_messages: totals.messages,
      ...agentAttrs(totals.agent, totals.agentType),
      ...ctx.commonAttrs,
    },
  })
  void ctx.log("debug", "otel: session.idle", {
    sessionID,
    duration_ms: durationMs,
    total_tokens: totals.tokens,
    total_cost_usd: totals.cost,
    total_messages: totals.messages,
  })
}

/** Ends and clears any dangling step/tool spans for a session execution. */
function sweepExecution(sessionID: string, ctx: HandlerContext) {
  for (const [callID, span] of ctx.tracing.toolSpans) {
    if (ctx.tracing.toolMeta.get(callID)?.sessionID !== sessionID) continue
    span.setStatus({ code: SpanStatusCode.ERROR, message: "session execution ended before tool completed" })
    span.end()
    ctx.tracing.toolSpans.delete(callID)
    ctx.tracing.toolSpanContexts.delete(callID)
    ctx.tracing.toolMeta.delete(callID)
  }
  for (const [messageID, meta] of ctx.tracing.stepMeta) {
    if (meta.sessionID !== sessionID) continue
    const span = ctx.tracing.stepSpans.get(messageID)
    if (span) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "session execution ended before step completed" })
      span.end()
    }
    ctx.tracing.stepSpans.delete(messageID)
    ctx.tracing.stepSpanContexts.delete(messageID)
    ctx.tracing.stepMeta.delete(messageID)
  }
  for (const [id, perm] of ctx.tracing.pendingPermissions) {
    if (perm.sessionID === sessionID) ctx.tracing.pendingPermissions.delete(id)
  }
}
