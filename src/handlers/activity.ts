import { SeverityNumber } from "@opentelemetry/api-logs"
import type { EventSessionDiff } from "@opencode-ai/sdk"
import { agentAttrs, getSessionAgentMeta, isMetricEnabled, setBoundedMap } from "../util.ts"
import type { HandlerContext } from "../types.ts"

/**
 * Records lines-added/removed for a `session.diff` event. opencode publishes each event
 * with the cumulative session diff (first snapshot → latest), so we emit two instruments:
 * `opencode.lines_of_code.count` (Counter) receives only the *positive* per-event delta
 * for each dimension (additions, deletions). Negative deltas — opencode reporting a smaller
 * cumulative for a dimension than the previous event — are dropped, so the counter reports
 * gross positive churn and does not reconcile to net after any revert (full or partial).
 * `opencode.lines_of_code.total` (Gauge) mirrors opencode's current cumulative value on
 * every event and is the authoritative live view.
 */
export function handleSessionDiff(e: EventSessionDiff, ctx: HandlerContext) {
  const sessionID = e.properties.sessionID
  const linesEnabled = isMetricEnabled("lines_of_code.count", ctx)
  const totalEnabled = isMetricEnabled("lines_of_code.total", ctx)
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
  if (ctx.sessionDiffTotals.has(sessionID)) {
    // Existing session: update in place. Calling setBoundedMap on a full map would
    // evict an unrelated session here, and that session's next session.diff would
    // be treated as first-seen — reintroducing the cumulative double-count bug.
    ctx.sessionDiffTotals.set(sessionID, nextTotals)
  } else {
    setBoundedMap(ctx.sessionDiffTotals, sessionID, nextTotals)
  }

  const baseAttrs = { ...ctx.commonAttrs, "session.id": sessionID }

  if (linesEnabled) {
    if (deltaAdded > 0) {
      ctx.instruments.linesCounter.add(deltaAdded, { ...baseAttrs, type: "added" })
    }
    if (deltaRemoved > 0) {
      ctx.instruments.linesCounter.add(deltaRemoved, { ...baseAttrs, type: "removed" })
    }
  }
  if (totalEnabled) {
    ctx.instruments.linesTotalGauge.record(totalAdded, { ...baseAttrs, type: "added" })
    ctx.instruments.linesTotalGauge.record(totalRemoved, { ...baseAttrs, type: "removed" })
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

/**
 * Detects `git commit` invocations in completed bash tool calls and increments the
 * commit counter and emits a `commit` log event. Called from the tool-completion
 * branch of `handleMessagePartUpdated` — opencode's `command.executed` event covers
 * slash commands only and never fires for bash tool calls.
 */
export function handleToolResult(
  toolName: string,
  toolInput: { [key: string]: unknown } | undefined,
  sessionID: string,
  ctx: HandlerContext,
) {
  if (toolName !== "bash") return
  const input = toolInput ?? {}
  const command = typeof input["command"] === "string" ? input["command"] : ""
  const description = typeof input["description"] === "string" ? input["description"] : ""
  if (!GIT_COMMIT_RE.test(command) && !GIT_COMMIT_RE.test(description)) return
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx)

  if (isMetricEnabled("commit.count", ctx)) {
    ctx.instruments.commitCounter.add(1, {
      ...ctx.commonAttrs,
      "session.id": sessionID,
    })
    ctx.log("debug", "otel: commit counter incremented", { sessionID })
  }
  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: "commit",
    attributes: {
      "event.name": "commit",
      "session.id": sessionID,
      ...agentAttrs(agentName, agentType),
      ...ctx.commonAttrs,
    },
  })
}
