import { SeverityNumber } from "@opentelemetry/api-logs"
import type { EventSessionDiff, EventCommandExecuted } from "@opencode-ai/sdk"
import { isMetricEnabled } from "../util.ts"
import type { HandlerContext } from "../types.ts"

/** Records lines-added and lines-removed metrics for each file in the diff. */
export function handleSessionDiff(e: EventSessionDiff, ctx: HandlerContext) {
  const sessionID = e.properties.sessionID
  const linesEnabled = isMetricEnabled("lines_of_code.count", ctx)
  let totalAdded = 0
  let totalRemoved = 0
  for (const fileDiff of e.properties.diff) {
    if (fileDiff.additions > 0) {
      if (linesEnabled) {
        ctx.instruments.linesCounter.add(fileDiff.additions, {
          ...ctx.commonAttrs,
          "session.id": sessionID,
          type: "added",
        })
      }
      totalAdded += fileDiff.additions
    }
    if (fileDiff.deletions > 0) {
      if (linesEnabled) {
        ctx.instruments.linesCounter.add(fileDiff.deletions, {
          ...ctx.commonAttrs,
          "session.id": sessionID,
          type: "removed",
        })
      }
      totalRemoved += fileDiff.deletions
    }
  }
  ctx.log("debug", "otel: lines_of_code counter incremented", {
    sessionID,
    files: e.properties.diff.length,
    added: totalAdded,
    removed: totalRemoved,
  })
}

const GIT_COMMIT_RE = /\bgit\s+commit(?![-\w])/

/** Detects `git commit` invocations in bash tool calls and increments the commit counter and emits a `commit` log event. */
export function handleCommandExecuted(e: EventCommandExecuted, ctx: HandlerContext) {
  if (e.properties.name !== "bash") return
  ctx.log("debug", "otel: command.executed (bash)", { sessionID: e.properties.sessionID, argumentsLength: e.properties.arguments.length })
  if (!GIT_COMMIT_RE.test(e.properties.arguments)) return

  if (isMetricEnabled("commit.count", ctx)) {
    ctx.instruments.commitCounter.add(1, {
      ...ctx.commonAttrs,
      "session.id": e.properties.sessionID,
    })
    ctx.log("debug", "otel: commit counter incremented", { sessionID: e.properties.sessionID })
  }
  ctx.logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: "commit",
    attributes: {
      "event.name": "commit",
      "session.id": e.properties.sessionID,
      ...ctx.commonAttrs,
    },
  })
}
