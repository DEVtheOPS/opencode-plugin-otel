import { SeverityNumber } from "@opentelemetry/api-logs"
import type { EventSessionDiff, EventCommandExecuted } from "@opencode-ai/sdk"
import { agentAttrs, getSessionAgentMeta, isMetricEnabled, setBoundedMap } from "../util.ts"
import type { HandlerContext } from "../types.ts"

/**
 * Records gross positive line churn for a `session.diff` event. opencode publishes each event
 * with the cumulative session diff (first snapshot → latest), so `opencode.lines_of_code.count`
 * (Counter) receives only the *positive* per-event delta for each dimension (additions,
 * deletions). Negative deltas — opencode reporting a smaller cumulative for a dimension than
 * the previous event — are dropped, so the counter reports gross positive churn and does not
 * reconcile to net after any revert (full or partial). The cumulative totals are still tracked
 * in `sessionDiffTotals` and reported as net per-session values by
 * `opencode.session.lines_of_code.total` on `session.idle`.
 */
export function handleSessionDiff(e: EventSessionDiff, ctx: HandlerContext) {
  const sessionID = e.properties.sessionID
  const linesEnabled = isMetricEnabled("lines_of_code.count", ctx)
  let totalAdded = 0
  let totalRemoved = 0
  for (const fileDiff of e.properties.diff) {
    totalAdded += fileDiff.additions
    totalRemoved += fileDiff.deletions
  }

  const prev = ctx.sessionDiffTotals.get(sessionID) ?? { additions: 0, deletions: 0 }
  const deltaAdded = totalAdded - prev.additions
  const deltaRemoved = totalRemoved - prev.deletions
  const nextTotals = { additions: totalAdded, deletions: totalRemoved }
  setBoundedMap(ctx.sessionDiffTotals, sessionID, nextTotals)

  if (linesEnabled) {
    if (deltaAdded > 0) {
      ctx.instruments.linesCounter.add(deltaAdded, { ...ctx.commonAttrs, type: "added" })
    }
    if (deltaRemoved > 0) {
      ctx.instruments.linesCounter.add(deltaRemoved, { ...ctx.commonAttrs, type: "removed" })
    }
  }

  ctx.log("debug", "otel: lines_of_code metrics updated", {
    sessionID,
    files: e.properties.diff.length,
    deltaAdded,
    deltaRemoved,
    totalAdded,
    totalRemoved,
  })
}

const GIT_COMMIT_RE = /\bgit\s+commit(?![-\w])/

/** Detects `git commit` invocations in bash tool calls and increments the commit counter and emits a `commit` log event. */
export function handleCommandExecuted(e: EventCommandExecuted, ctx: HandlerContext) {
  if (e.properties.name !== "bash") return
  ctx.log("debug", "otel: command.executed (bash)", { sessionID: e.properties.sessionID, argumentsLength: e.properties.arguments.length })
  if (!GIT_COMMIT_RE.test(e.properties.arguments)) return
  const { agentName, agentType } = getSessionAgentMeta(e.properties.sessionID, ctx)

  if (isMetricEnabled("commit.count", ctx)) {
    ctx.instruments.commitCounter.add(1, ctx.commonAttrs)
    ctx.log("debug", "otel: commit counter incremented", { sessionID: e.properties.sessionID })
  }
  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: "commit",
    attributes: {
      "event.name": "commit",
      "session.id": e.properties.sessionID,
      ...agentAttrs(agentName, agentType),
      ...ctx.commonAttrs,
    },
  })
}
