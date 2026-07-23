import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanStatusCode } from "@opentelemetry/api"
import type { EventSessionCreated, EventSessionIdle, EventSessionError, EventSessionStatus } from "@opencode-ai/sdk"
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
  errorSummary,
  getSessionAgentMeta,
  setBoundedMap,
  isMetricEnabled,
  isTraceEnabled,
  resolveSessionTraceContext,
} from "../util.ts"
import type { HandlerContext, SessionAgentType } from "../types.ts"

const OPENINFERENCE_SPAN_KIND = SemanticConventions.OPENINFERENCE_SPAN_KIND

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
  ctx.pendingRuns.delete(sessionID)
  if (promptText) setBoundedMap(ctx.runInputs, runID, promptText)
  if (!isTraceEnabled("session", ctx)) return
  const existing = ctx.runSpans.get(runID)
  if (existing) {
    existing.setAttributes({
      [AGENT_NAME]: agent,
      ...(promptText
        ? {
            [INPUT_VALUE]: promptText,
            [INPUT_MIME_TYPE]: MimeType.TEXT,
            [LLM_INPUT_MESSAGES]: JSON.stringify([{ role: "user", content: promptText }]),
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
        "agent.type": "primary",
        "session.is_subagent": false,
        ...(promptText
          ? {
              [INPUT_VALUE]: promptText,
              [INPUT_MIME_TYPE]: MimeType.TEXT,
              [LLM_INPUT_MESSAGES]: JSON.stringify([{ role: "user", content: promptText }]),
            }
          : {}),
        model,
        ...ctx.commonAttrs,
      },
    },
    ctx.rootContext(),
  )
  ctx.runSpans.set(runID, runSpan)
  setBoundedMap(ctx.runSpanContexts, runID, runSpan.spanContext())
}

/** Increments the session counter, records start time, starts the root session span, and emits a `session.created` log event. */
export function handleSessionCreated(e: EventSessionCreated, ctx: HandlerContext) {
  const { id: sessionID, time, parentID } = e.properties.info
  const createdAt = time.created
  const isSubagent = !!parentID
  const agentType: SessionAgentType = isSubagent ? "subagent" : "primary"
  if (isMetricEnabled("session.count", ctx)) {
    ctx.instruments.sessionCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, is_subagent: isSubagent })
  }
  setBoundedMap(ctx.sessionTotals, sessionID, { startMs: createdAt, tokens: 0, cost: 0, messages: 0, agent: "unknown", agentType })

  if (isTraceEnabled("session", ctx) && parentID) {
    const sessionSpan = ctx.tracer.startSpan(
      `${ctx.tracePrefix}session`,
      {
        startTime: createdAt,
        attributes: {
          [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
          [SESSION_ID]: sessionID,
          [AGENT_NAME]: "unknown",
          "agent.type": agentType,
          "session.is_subagent": isSubagent,
          ...ctx.commonAttrs,
        },
      },
      resolveSessionTraceContext(parentID, ctx),
    )
    ctx.sessionSpans.set(sessionID, sessionSpan)
    setBoundedMap(ctx.sessionSpanContexts, sessionID, sessionSpan.spanContext())
  }

  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: createdAt,
    observedTimestamp: Date.now(),
    body: "session.created",
    attributes: {
      "event.name": "session.created",
      "session.id": sessionID,
      is_subagent: isSubagent,
      ...agentAttrs("unknown", agentType),
      ...ctx.commonAttrs,
    },
  })
  return ctx.log("info", "otel: session.created", { sessionID, createdAt, isSubagent })
}

function sweepSession(sessionID: string, ctx: HandlerContext) {
  for (const [id, perm] of ctx.pendingPermissions) {
    if (perm.sessionID === sessionID) ctx.pendingPermissions.delete(id)
  }
  for (const [key, span] of ctx.pendingToolSpans) {
    if (span.sessionID === sessionID) {
      span.span?.setStatus({ code: SpanStatusCode.ERROR, message: "session ended before tool completed" })
      span.span?.end()
      ctx.pendingToolSpans.delete(key)
    }
  }
  ctx.pendingRuns.delete(sessionID)
  const msgPrefix = `${sessionID}:`
  for (const [key, span] of ctx.messageSpans) {
    if (key.startsWith(msgPrefix)) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "session ended before message completed" })
      span.end()
      ctx.messageSpans.delete(key)
    }
  }
  for (const key of ctx.messageOutputs.keys()) {
    if (key.startsWith(msgPrefix)) ctx.messageOutputs.delete(key)
  }
  for (const key of ctx.llmRequestContexts.keys()) {
    if (key.startsWith(msgPrefix)) ctx.llmRequestContexts.delete(key)
  }
}

/** Emits a `session.idle` log event, records duration and session total histograms, ends the session span, and clears pending state. */
export function handleSessionIdle(e: EventSessionIdle, ctx: HandlerContext) {
  const sessionID = e.properties.sessionID
  const totals = ctx.sessionTotals.get(sessionID)
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx)
  ctx.sessionTotals.delete(sessionID)
  ctx.sessionDiffTotals.delete(sessionID)
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

  const sessionSpan = ctx.sessionSpans.get(sessionID)
  if (sessionSpan) {
    if (totals) {
      sessionSpan.setAttributes({
        [AGENT_NAME]: totals.agent,
        "agent.type": totals.agentType,
        "session.total_tokens": totals.tokens,
        "session.total_cost_usd": totals.cost,
        "session.total_messages": totals.messages,
      })
    }
    sessionSpan.setStatus({ code: SpanStatusCode.OK })
    sessionSpan.end()
    ctx.sessionSpans.delete(sessionID)
  }
  const runID = ctx.activeRuns.get(sessionID)
  if (runID) ctx.activeRuns.delete(sessionID)
  const runSpan = runID ? ctx.runSpans.get(runID) : undefined
  if (runSpan) {
    if (totals) {
      runSpan.setAttributes({
        [AGENT_NAME]: totals.agent,
        "agent.type": totals.agentType,
        "session.total_tokens": totals.tokens,
        "session.total_cost_usd": totals.cost,
        "session.total_messages": totals.messages,
      })
    }
    runSpan.setStatus({ code: SpanStatusCode.OK })
    runSpan.end()
    ctx.runSpans.delete(runID!)
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
      total_tokens: totals?.tokens ?? 0,
      total_cost_usd: totals?.cost ?? 0,
      total_messages: totals?.messages ?? 0,
      ...agentAttrs(agentName, agentType),
      ...ctx.commonAttrs,
    },
  })
  ctx.log("debug", "otel: session.idle", {
    sessionID,
    ...(totals ? { duration_ms, total_tokens: totals.tokens, total_cost_usd: totals.cost, total_messages: totals.messages } : {}),
  })
}

/** Emits a `session.error` log event, ends the session span with error status, and clears any pending state for the session. */
export function handleSessionError(e: EventSessionError, ctx: HandlerContext) {
  const rawID = e.properties.sessionID
  const sessionID = rawID ?? "unknown"
  const error = errorSummary(e.properties.error)
  const { agentName, agentType } = rawID ? getSessionAgentMeta(rawID, ctx) : { agentName: "unknown", agentType: "unknown" as const }
  const totals = rawID ? ctx.sessionTotals.get(rawID) : undefined
  if (rawID) {
    ctx.sessionTotals.delete(rawID)
    ctx.sessionDiffTotals.delete(rawID)
  }
  sweepSession(sessionID, ctx)

  if (rawID) {
    const sessionSpan = ctx.sessionSpans.get(rawID)
    if (sessionSpan) {
      if (totals) sessionSpan.setAttributes({ [AGENT_NAME]: totals.agent, "agent.type": totals.agentType })
      sessionSpan.setStatus({ code: SpanStatusCode.ERROR, message: error })
      sessionSpan.setAttribute("error", error)
      sessionSpan.end()
      ctx.sessionSpans.delete(rawID)
    }
    const runID = ctx.activeRuns.get(rawID)
    if (runID) ctx.activeRuns.delete(rawID)
    const runSpan = runID ? ctx.runSpans.get(runID) : undefined
    if (runSpan) {
      if (totals) runSpan.setAttributes({ [AGENT_NAME]: totals.agent, "agent.type": totals.agentType })
      runSpan.setStatus({ code: SpanStatusCode.ERROR, message: error })
      runSpan.setAttribute("error", error)
      runSpan.end()
      ctx.runSpans.delete(runID!)
    }
  }

  ctx.emitLog({
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: "session.error",
    attributes: {
      "event.name": "session.error",
      "session.id": sessionID,
      error,
      ...agentAttrs(agentName, agentType),
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
