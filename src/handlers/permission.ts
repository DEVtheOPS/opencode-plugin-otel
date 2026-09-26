import { SeverityNumber } from "@opentelemetry/api-logs"
import type { EventOf, HandlerContext } from "../types.ts"
import { agentAttrs, getSessionAgentMeta, setBoundedMap } from "../util.ts"

/** Stores an answered permission prompt for correlation when the reply arrives. */
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
}

/** Emits a `tool_decision` log event recording whether the permission was accepted or rejected. */
export function handlePermissionReplied(e: EventOf<"permission.replied">, ctx: HandlerContext) {
  const d = e.data
  const pending = ctx.tracing.pendingPermissions.get(d.requestID)
  ctx.tracing.pendingPermissions.delete(d.requestID)
  const decision = d.reply === "reject" ? "reject" : "accept"
  const { agentName, agentType } = getSessionAgentMeta(d.sessionID, ctx)

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
