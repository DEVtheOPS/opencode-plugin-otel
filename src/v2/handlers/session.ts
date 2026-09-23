import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanStatusCode, trace } from "@opentelemetry/api"
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
import {
  agentAttrs,
  getSessionAgentMeta,
  isMetricEnabled,
  isTraceEnabled,
  resolveSessionTraceContext,
  setBoundedMap,
} from "../util.ts"
import type { HandlerContext, SessionAgentType } from "../types.ts"
import { errorSummary, modelRef, type V2Error, type V2Model } from "../v2.ts"

const OPENINFERENCE_SPAN_KIND = SemanticConventions.OPENINFERENCE_SPAN_KIND

/**
 * Creates the session totals entry on first sight. V2 does not always emit `session.created`
 * (e.g. for sessions that predate the plugin), so totals are created lazily from whichever
 * event arrives first. The session counter and `session.created` log are emitted exactly once.
 */
export function ensureSessionTotals(
  sessionID: string,
  agent: string,
  agentType: SessionAgentType,
  createdAt: number,
  ctx: HandlerContext,
): boolean {
  const existing = ctx.sessionTotals.get(sessionID)
  if (existing) {
    if (agent && agent !== "unknown" && (existing.agent !== agent || existing.agentType !== agentType)) {
      setBoundedMap(ctx.sessionTotals, sessionID, { ...existing, agent, agentType })
    }
    return false
  }
  if (isMetricEnabled("session.count", ctx)) {
    ctx.instruments.sessionCounter.add(1, {
      ...ctx.commonAttrs,
      "session.id": sessionID,
      is_subagent: agentType === "subagent",
    })
  }
  setBoundedMap(ctx.sessionTotals, sessionID, {
    startMs: createdAt,
    tokens: 0,
    cost: 0,
    messages: 0,
    agent,
    agentType,
  })
  const prevMeta = ctx.sessionMeta.get(sessionID)
  setBoundedMap(ctx.sessionMeta, sessionID, {
    agent: agent !== "unknown" ? agent : (prevMeta?.agent ?? "unknown"),
    model: prevMeta?.model ?? "unknown",
  })
  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: createdAt,
    observedTimestamp: Date.now(),
    body: "session.created",
    attributes: {
      "event.name": "session.created",
      "session.id": sessionID,
      is_subagent: agentType === "subagent",
      ...agentAttrs(agent, agentType),
      ...ctx.commonAttrs,
    },
  })
  return true
}

/** Starts or refreshes the root run span for a single user turn, keyed by the user message ID. */
export function handleRunStarted(
  runID: string,
  sessionID: string,
  agent: string,
  promptText: string,
  model: string,
  startTime: number,
  ctx: HandlerContext,
) {
  ctx.activeRuns.set(sessionID, runID)
  const safePrompt = ctx.redact(promptText)
  if (!isTraceEnabled("session", ctx)) return
  const totals = ctx.sessionTotals.get(sessionID)
  const agentType: SessionAgentType | "unknown" = totals?.agentType ?? "primary"
  const isSubagent = agentType === "subagent"
  const existing = ctx.runSpans.get(runID)
  if (existing) {
    existing.setAttributes({
      [AGENT_NAME]: agent,
      "agent.type": agentType,
      "session.is_subagent": isSubagent,
      ...(promptText
        ? {
            [INPUT_VALUE]: safePrompt,
            [INPUT_MIME_TYPE]: MimeType.TEXT,
            [LLM_INPUT_MESSAGES]: JSON.stringify([{ role: "user", content: safePrompt }]),
          }
        : {}),
      model,
    })
    return
  }

  const runSpan = ctx.tracer.startSpan(
    `${ctx.tracePrefix}session`,
    {
      startTime,
      attributes: {
        [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
        [SESSION_ID]: sessionID,
        [AGENT_NAME]: agent,
        "agent.type": agentType,
        "session.is_subagent": isSubagent,
        ...(promptText
          ? {
              [INPUT_VALUE]: safePrompt,
              [INPUT_MIME_TYPE]: MimeType.TEXT,
              [LLM_INPUT_MESSAGES]: JSON.stringify([{ role: "user", content: safePrompt }]),
            }
          : {}),
        model,
        ...ctx.commonAttrs,
      },
    },
    // Subagent turns nest under their session span (itself under the parent's dispatch
    // tool span); primary turns resolve to the root context.
    ctx.sessionSpans.get(sessionID)
      ? trace.setSpan(ctx.rootContext(), ctx.sessionSpans.get(sessionID)!)
      : ctx.rootContext(),
  )
  ctx.runSpans.set(runID, runSpan)
  setBoundedMap(ctx.runSpanContexts, runID, runSpan.spanContext())
}

/** Records a session's creation, starting a subagent session span when it has a parent. */
export function handleSessionCreated(
  data: { sessionID: string; parentID?: string; agent?: string; model?: V2Model; title?: string },
  createdAt: number,
  ctx: HandlerContext,
) {
  const sessionID = data.sessionID
  const isSubagent = !!data.parentID
  const agentType: SessionAgentType = isSubagent ? "subagent" : "primary"
  const agent = data.agent ?? "unknown"
  ensureSessionTotals(sessionID, agent, agentType, createdAt, ctx)
  setBoundedMap(ctx.sessionMeta, sessionID, {
    agent,
    model: data.model ? modelRef(data.model) : (ctx.sessionMeta.get(sessionID)?.model ?? "unknown"),
  })

  if (isTraceEnabled("session", ctx) && data.parentID) {
    // Nest under the parent's subagent-dispatch tool span when available, so the whole
    // subagent subtree hangs off `opencode.tool.subagent`.
    const dispatchSpan = ctx.pendingSubagentSpans.get(data.parentID)
    const parentContext = dispatchSpan
      ? trace.setSpan(ctx.rootContext(), dispatchSpan)
      : resolveSessionTraceContext(data.parentID, ctx)
    const sessionSpan = ctx.tracer.startSpan(
      `${ctx.tracePrefix}session`,
      {
        startTime: createdAt,
        attributes: {
          [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
          [SESSION_ID]: sessionID,
          [AGENT_NAME]: agent,
          "agent.type": agentType,
          "session.is_subagent": isSubagent,
          ...(data.model ? { model: modelRef(data.model) } : {}),
          ...ctx.commonAttrs,
        },
      },
      parentContext,
    )
    ctx.sessionSpans.set(sessionID, sessionSpan)
    setBoundedMap(ctx.sessionSpanContexts, sessionID, sessionSpan.spanContext())
  }

  return ctx.log("info", "otel: session.created", { sessionID, createdAt, isSubagent })
}

function sweepSession(sessionID: string, ctx: HandlerContext) {
  for (const [key, tool] of ctx.pendingToolSpans) {
    if (tool.sessionID === sessionID) {
      tool.span?.setStatus({ code: SpanStatusCode.ERROR, message: "session ended before tool completed" })
      tool.span?.end()
      ctx.pendingToolSpans.delete(key)
    }
  }
  const prefix = `${sessionID}:`
  for (const [key, step] of ctx.stepSpans) {
    if (key.startsWith(prefix)) {
      step.span.setStatus({ code: SpanStatusCode.ERROR, message: "session ended before step completed" })
      step.span.end()
      ctx.stepSpans.delete(key)
    }
  }
  for (const key of ctx.llmRequestContexts.keys()) {
    if (key.startsWith(prefix)) ctx.llmRequestContexts.delete(key)
  }
}

/** Ends the active run span for a turn, stamping the cumulative session totals. */
function endRunSpan(sessionID: string, ctx: HandlerContext, error?: string) {
  const totals = ctx.sessionTotals.get(sessionID)
  const runID = ctx.activeRuns.get(sessionID)
  if (runID) ctx.activeRuns.delete(sessionID)
  const runSpan = runID ? ctx.runSpans.get(runID) : undefined
  if (!runSpan) return
  if (totals) {
    runSpan.setAttributes({
      [AGENT_NAME]: totals.agent,
      "agent.type": totals.agentType,
      "session.total_tokens": totals.tokens,
      "session.total_cost_usd": totals.cost,
      "session.total_messages": totals.messages,
    })
  }
  if (error) {
    runSpan.setStatus({ code: SpanStatusCode.ERROR, message: error })
    runSpan.setAttribute("error", error)
  } else {
    runSpan.setStatus({ code: SpanStatusCode.OK })
  }
  runSpan.end()
  if (runID) ctx.runSpans.delete(runID)
}

/** Ends a subagent session span (created on `session.created`) so it exports at turn end. */
function endSessionSpan(sessionID: string, ctx: HandlerContext, error?: string) {
  const sessionSpan = ctx.sessionSpans.get(sessionID)
  if (!sessionSpan) return
  const totals = ctx.sessionTotals.get(sessionID)
  if (totals) {
    sessionSpan.setAttributes({
      [AGENT_NAME]: totals.agent,
      "agent.type": totals.agentType,
      "session.total_tokens": totals.tokens,
      "session.total_cost_usd": totals.cost,
      "session.total_messages": totals.messages,
    })
  }
  if (error) {
    sessionSpan.setStatus({ code: SpanStatusCode.ERROR, message: error })
    sessionSpan.setAttribute("error", error)
  } else {
    sessionSpan.setStatus({ code: SpanStatusCode.OK })
  }
  sessionSpan.end()
  ctx.sessionSpans.delete(sessionID)
}

/** V2 emits this per turn; creates the run span (ordered after `session.created`). */
export function handleExecutionStarted(data: { sessionID: string }, ctx: HandlerContext) {
  const sessionID = data.sessionID
  ensureSessionTotals(sessionID, "unknown", "primary", Date.now(), ctx)
  if (ctx.activeRuns.get(sessionID)) return
  const meta = ctx.sessionMeta.get(sessionID)
  const totals = ctx.sessionTotals.get(sessionID)
  const agent = meta?.agent ?? totals?.agent ?? "unknown"
  const model = meta?.model ?? "unknown"
  const promptText = ctx.runPrompts.get(sessionID) ?? ""
  // runID = sessionID: one run span per turn, ended (and replaced) on execution end.
  handleRunStarted(sessionID, sessionID, agent, promptText, model, Date.now(), ctx)
}

/** V2 emits this when a turn completes; ends the run span. */
export function handleExecutionEnded(
  data: { sessionID: string; reason?: string },
  ctx: HandlerContext,
  error?: V2Error,
) {
  const sessionID = data.sessionID
  const totals = ctx.sessionTotals.get(sessionID)
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx)
  endRunSpan(sessionID, ctx, error ? errorSummary(error) : undefined)
  endSessionSpan(sessionID, ctx, error ? errorSummary(error) : undefined)
  // Clear per-turn state so the next turn starts a fresh run span and prompt log.
  ctx.promptEmitted.delete(sessionID)
  ctx.runPrompts.delete(sessionID)

  const attrs = { ...ctx.commonAttrs, "session.id": sessionID }
  if (totals) {
    if (isMetricEnabled("session.duration", ctx)) {
      ctx.instruments.sessionDurationHistogram.record(Date.now() - totals.startMs, attrs)
    }
    if (isMetricEnabled("session.token.total", ctx)) {
      ctx.instruments.sessionTokenGauge.record(totals.tokens, attrs)
    }
    if (isMetricEnabled("session.cost.total", ctx)) {
      ctx.instruments.sessionCostGauge.record(totals.cost, attrs)
    }
  }

  ctx.emitLog({
    severityNumber: error ? SeverityNumber.ERROR : SeverityNumber.INFO,
    severityText: error ? "ERROR" : "INFO",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: error ? "session.error" : "session.execution.succeeded",
    attributes: {
      "event.name": error ? "session.error" : "session.execution.succeeded",
      "session.id": sessionID,
      ...(error ? { error: errorSummary(error) } : {}),
      total_tokens: totals?.tokens ?? 0,
      total_cost_usd: totals?.cost ?? 0,
      total_messages: totals?.messages ?? 0,
      ...agentAttrs(agentName, agentType),
      ...ctx.commonAttrs,
    },
  })
  ctx.log(error ? "error" : "debug", error ? "otel: session.execution.failed" : "otel: session.execution.succeeded", {
    sessionID,
    reason: data.reason,
    ...(error ? { error: errorSummary(error) } : {}),
  })
}

/** Session idle: end any remaining spans and clear per-session bookkeeping. */
export function handleSessionIdle(sessionID: string, ctx: HandlerContext) {
  const totals = ctx.sessionTotals.get(sessionID)
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx)
  ctx.sessionTotals.delete(sessionID)
  sweepSession(sessionID, ctx)

  const attrs = { ...ctx.commonAttrs, "session.id": sessionID }
  if (totals) {
    if (isMetricEnabled("session.duration", ctx)) {
      ctx.instruments.sessionDurationHistogram.record(Date.now() - totals.startMs, attrs)
    }
    if (isMetricEnabled("session.token.total", ctx)) {
      ctx.instruments.sessionTokenGauge.record(totals.tokens, attrs)
    }
    if (isMetricEnabled("session.cost.total", ctx)) {
      ctx.instruments.sessionCostGauge.record(totals.cost, attrs)
    }
  }
  endRunSpan(sessionID, ctx)
  endSessionSpan(sessionID, ctx)

  ctx.emitLog({
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
      ...agentAttrs(agentName, agentType),
      ...ctx.commonAttrs,
    },
  })
  ctx.log("debug", "otel: session.idle", { sessionID })
}

/** Emits a `session.error` log event and ends the run span with error status. */
export function handleExecutionFailed(data: { sessionID: string; error?: V2Error }, ctx: HandlerContext) {
  handleExecutionEnded({ sessionID: data.sessionID }, ctx, data.error)
}

/** Increments the retry counter when the session enters a retry state. */
export function handleSessionStatus(
  data: { sessionID: string; status?: { type: string; attempt?: number; message?: string } },
  ctx: HandlerContext,
) {
  if (data.status?.type !== "retry") return
  const { sessionID, status } = data
  if (isMetricEnabled("retry.count", ctx)) {
    ctx.instruments.retryCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID })
    ctx.log("debug", "otel: retry counter incremented", {
      sessionID,
      attempt: status.attempt,
      retryMessage: status.message,
    })
  }
}
