import { SpanStatusCode, trace } from "@opentelemetry/api"
import { SeverityNumber } from "@opentelemetry/api-logs"
import { AGENT_NAME, SESSION_ID } from "@arizeai/openinference-semantic-conventions"
import type { EventOf, HandlerContext } from "../types.ts"
import { agentAttrs, getSessionAgentMeta, isTraceEnabled, resolveRunContext, setBoundedMap } from "../util.ts"

/** Starts a permission span for a permission prompt so approval waits are visible in traces. */
export function handlePermissionAsked(e: EventOf<"permission.asked">, ctx: HandlerContext) {
  const d = e.data
  setBoundedMap(ctx.tracing.pendingPermissions, d.id, {
    action: d.action,
    resources: d.resources,
    sessionID: d.sessionID,
  })
  void ctx.log("debug", "otel: permission asked", {
    requestID: d.id,
    sessionID: d.sessionID,
    action: d.action,
  })
  if (!isTraceEnabled("permission", ctx)) return
  // The approval happens between a step's model response and its tool execution,
  // so parent the span to the active step (the LLM span) and fall back to the run span.
  const activeStep = ctx.tracing.activeStepSpans.get(d.sessionID)
  const parent = activeStep
    ? trace.setSpan(resolveRunContext(d.sessionID, ctx), activeStep)
    : resolveRunContext(d.sessionID, ctx)
  const span = ctx.tracer.startSpan(
    `${ctx.tracePrefix}permission`,
    {
      startTime: e.created,
      attributes: {
        [SESSION_ID]: d.sessionID,
        "permission.action": d.action,
        ...ctx.commonAttrs,
      },
    },
    parent,
  )
  setBoundedMap(ctx.tracing.permissionSpans, d.id, span)
}

/** Ends the permission span and emits a `tool_decision` log event recording whether the permission was accepted or rejected. */
export function handlePermissionReplied(e: EventOf<"permission.replied">, ctx: HandlerContext) {
  const d = e.data
  const pending = ctx.tracing.pendingPermissions.get(d.requestID)
  ctx.tracing.pendingPermissions.delete(d.requestID)
  const decision = d.reply === "reject" ? "reject" : "accept"
  const { agentName, agentType } = getSessionAgentMeta(d.sessionID, ctx)

  const span = ctx.tracing.permissionSpans.get(d.requestID)
  if (span) {
    span.setAttributes({
      "permission.decision": decision,
      "permission.source": d.reply,
      ...(pending ? { "permission.action": pending.action } : {}),
      [AGENT_NAME]: agentName,
      "agent.type": agentType,
    })
    span.setStatus({ code: decision === "accept" ? SpanStatusCode.OK : SpanStatusCode.ERROR })
    span.end(e.created)
    ctx.tracing.permissionSpans.delete(d.requestID)
  }

  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: e.created,
    observedTimestamp: Date.now(),
    body: "tool_decision",
    attributes: {
      "event.name": "tool_decision",
      "session.id": d.sessionID,
      tool_name: pending?.action ?? "unknown",
      ...(pending ? { resources: pending.resources.join(",") } : {}),
      decision,
      source: d.reply,
      ...agentAttrs(agentName, agentType),
      ...ctx.commonAttrs,
    },
  })
}

/** Ends permission spans still open when a session execution ends. */
export function sweepPermissionSpans(sessionID: string, ctx: HandlerContext) {
  for (const [id, span] of ctx.tracing.permissionSpans) {
    const pending = ctx.tracing.pendingPermissions.get(id)
    if (pending?.sessionID !== sessionID) continue
    span.setAttributes({ "permission.decision": "cancelled" })
    span.setStatus({ code: SpanStatusCode.ERROR, message: "session execution ended before the permission was answered" })
    span.end()
    ctx.tracing.permissionSpans.delete(id)
  }
}
