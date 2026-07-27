import { SeverityNumber } from "@opentelemetry/api-logs"
import type { EventPermissionUpdated, EventPermissionReplied } from "@opencode-ai/sdk"
import { agentAttrs, getSessionAgentMeta, setBoundedMap } from "../util.ts"
import type { HandlerContext } from "../types.ts"

/** Stores a pending permission prompt in the context map for later correlation with its reply. */
export function handlePermissionUpdated(e: EventPermissionUpdated, ctx: HandlerContext) {
  const perm = e.properties
  setBoundedMap(ctx.pendingPermissions, perm.id, {
    type: perm.type,
    title: perm.title,
    sessionID: perm.sessionID,
  })
  ctx.log("debug", "otel: permission stored", { permissionID: perm.id, sessionID: perm.sessionID, type: perm.type, title: perm.title })
}

/** Emits a `tool_decision` log event recording whether the permission was accepted or rejected. */
export function handlePermissionReplied(e: EventPermissionReplied, ctx: HandlerContext) {
  const { permissionID, sessionID, response } = e.properties
  const pending = ctx.pendingPermissions.get(permissionID)
  ctx.pendingPermissions.delete(permissionID)
  const decision = response === "allow" || response === "allowAlways" ? "accept" : "reject"
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx)
  ctx.log("debug", "otel: tool_decision emitted", { permissionID, sessionID, decision, source: response, tool_name: pending?.title ?? "unknown" })
  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: "tool_decision",
    attributes: {
      "event.name": "tool_decision",
      "session.id": sessionID,
      tool_name: pending?.title ?? "unknown",
      tool_type: pending?.type ?? "unknown",
      decision,
      source: response,
      ...agentAttrs(agentName, agentType),
      ...ctx.commonAttrs,
    },
  })
}
