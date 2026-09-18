import { describe, test, expect } from "bun:test"
import { handleSessionCreated, handleSessionIdle, handleSessionError, handleSessionDeleted, handleSessionStatus, handleRunStarted } from "../../src/handlers/session.ts"
import { handleSessionDiff } from "../../src/handlers/activity.ts"
import { makeCtx, makeTracer } from "../helpers.ts"
import type { EventSessionCreated, EventSessionIdle, EventSessionError, EventSessionDeleted, EventSessionStatus, EventSessionDiff } from "@opencode-ai/sdk"
import type { Span } from "@opentelemetry/api"

function makeSessionCreated(sessionID: string, createdAt = 1000, parentID?: string): EventSessionCreated {
  return {
    type: "session.created",
    properties: {
      info: {
        id: sessionID,
        projectID: "proj_test",
        directory: "/tmp",
        parentID,
        time: { created: createdAt },
      },
    },
  } as unknown as EventSessionCreated
}

function makeSessionIdle(sessionID: string): EventSessionIdle {
  return { type: "session.idle", properties: { sessionID } } as EventSessionIdle
}

function makeSessionError(sessionID: string, error?: { name: string }): EventSessionError {
  return {
    type: "session.error",
    properties: { sessionID, error },
  } as unknown as EventSessionError
}

function makeSessionDiff(sessionID: string, diff: Array<{ file: string; additions: number; deletions: number }>): EventSessionDiff {
  return { type: "session.diff", properties: { sessionID, diff } } as unknown as EventSessionDiff
}

function makeSessionDeleted(sessionID: string): EventSessionDeleted {
  return { type: "session.deleted", properties: { info: { id: sessionID } } } as unknown as EventSessionDeleted
}

function makeSessionStatus(sessionID: string, status: { type: "retry"; attempt: number; message: string; next: number } | { type: "busy" } | { type: "idle" }): EventSessionStatus {
  return { type: "session.status", properties: { sessionID, status } } as unknown as EventSessionStatus
}

describe("handleSessionCreated", () => {
  test("increments session counter", async () => {
    const { ctx, counters } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(counters.session.calls).toHaveLength(1)
    const call = counters.session.calls.at(0)!
    expect(call.value).toBe(1)
    expect(call.attrs["session.id"]).toBeUndefined()
    expect(call.attrs["is_subagent"]).toBe(false)
  })

  test("emits session.created log record with correct timestamp", async () => {
    const { ctx, logger } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1", 9999), ctx)
    expect(logger.records).toHaveLength(1)
    const record = logger.records.at(0)!
    expect(record.body).toBe("session.created")
    expect(record.timestamp).toBe(9999)
    expect(record.attributes?.["session.id"]).toBe("ses_1")
  })

  test("calls plugin log", async () => {
    const { ctx, pluginLog } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(pluginLog.calls).toHaveLength(1)
    const call = pluginLog.calls.at(0)!
    expect(call.level).toBe("info")
    expect(call.extra?.["sessionID"]).toBe("ses_1")
  })

  test("includes project.id in counter attrs", async () => {
    const { ctx, counters } = makeCtx("proj_abc")
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(counters.session.calls.at(0)!.attrs["project.id"]).toBe("proj_abc")
  })

  test("stores session totals with startMs", async () => {
    const { ctx } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1", 5000), ctx)
    expect(ctx.sessionTotals.has("ses_1")).toBe(true)
    const totals = ctx.sessionTotals.get("ses_1")!
    expect(totals.startMs).toBe(5000)
    expect(totals.tokens).toBe(0)
    expect(totals.cost).toBe(0)
    expect(totals.messages).toBe(0)
  })
})

describe("handleSessionIdle", () => {
  test("emits session.idle log record", () => {
    const { ctx, logger } = makeCtx()
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    expect(logger.records).toHaveLength(1)
    const record = logger.records.at(0)!
    expect(record.body).toBe("session.idle")
    expect(record.attributes?.["session.id"]).toBe("ses_1")
  })

  test("sweeps pendingPermissions for the session", () => {
    const { ctx } = makeCtx()
    ctx.pendingPermissions.set("perm_1", { type: "tool", title: "Read", sessionID: "ses_1" })
    ctx.pendingPermissions.set("perm_2", { type: "tool", title: "Write", sessionID: "ses_other" })
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    expect(ctx.pendingPermissions.has("perm_1")).toBe(false)
    expect(ctx.pendingPermissions.has("perm_2")).toBe(true)
  })

  test("sweeps pendingToolSpans for the session", () => {
    const { ctx } = makeCtx()
    const t = makeTracer()
    const span1 = t.startSpan("tool") as unknown as Span
    const span2 = t.startSpan("tool") as unknown as Span
    ctx.pendingToolSpans.set("ses_1:call_1", { tool: "bash", sessionID: "ses_1", startMs: 0, span: span1 })
    ctx.pendingToolSpans.set("ses_other:call_2", { tool: "bash", sessionID: "ses_other", startMs: 0, span: span2 })
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    expect(ctx.pendingToolSpans.has("ses_1:call_1")).toBe(false)
    expect(ctx.pendingToolSpans.has("ses_other:call_2")).toBe(true)
  })

  test("records session duration histogram when totals exist", async () => {
    const { ctx, histograms } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1", Date.now() - 1000), ctx)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    expect(histograms.sessionDuration.calls).toHaveLength(1)
    expect(histograms.sessionDuration.calls.at(0)!.value).toBeGreaterThan(0)
    expect(histograms.sessionDuration.calls.at(0)!.attrs["session.id"]).toBeUndefined()
  })

  test("records session token and cost histograms when totals exist", async () => {
    const { ctx, gauges } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    ctx.sessionTotals.set("ses_1", { startMs: Date.now() - 500, tokens: 150, cost: 0.03, messages: 2, agent: "build", agentType: "primary" })
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    expect(gauges.sessionToken.calls).toHaveLength(1)
    expect(gauges.sessionToken.calls.at(0)!.value).toBe(150)
    expect(gauges.sessionCost.calls).toHaveLength(1)
    expect(gauges.sessionCost.calls.at(0)!.value).toBe(0.03)
  })

  test("does not record the LOC histogram on idle", async () => {
    const { ctx, histograms } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 10, deletions: 0 }]), ctx)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    expect(histograms.sessionLinesTotal.calls).toHaveLength(0)
  })

  test("keeps the session diff baseline across idle so later turns emit true deltas", async () => {
    const { ctx, counters } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 10, deletions: 0 }]), ctx)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 25, deletions: 0 }]), ctx)
    const added = counters.lines.calls.filter((c) => c.attrs["type"] === "added").map((c) => c.value)
    expect(added).toEqual([10, 15])
    expect(ctx.sessionDiffTotals.get("ses_1")).toEqual({ additions: 25, deletions: 0 })
  })

  test("emits total_tokens and total_messages in log record attributes", async () => {
    const { ctx, logger } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    ctx.sessionTotals.set("ses_1", { startMs: Date.now() - 100, tokens: 200, cost: 0.05, messages: 3, agent: "general", agentType: "primary" })
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    const record = logger.records.find(r => r.body === "session.idle")!
    expect(record.attributes?.["total_tokens"]).toBe(200)
    expect(record.attributes?.["total_cost_usd"]).toBe(0.05)
    expect(record.attributes?.["total_messages"]).toBe(3)
    expect(record.attributes?.["agent.name"]).toBe("general")
    expect(record.attributes?.["agent.type"]).toBe("primary")
  })

  test("does not record histograms when no prior session.created", () => {
    const { ctx, histograms, gauges } = makeCtx()
    handleSessionIdle(makeSessionIdle("ses_unknown"), ctx)
    expect(histograms.sessionDuration.calls).toHaveLength(0)
    expect(gauges.sessionToken.calls).toHaveLength(0)
    expect(gauges.sessionCost.calls).toHaveLength(0)
    expect(histograms.sessionLinesTotal.calls).toHaveLength(0)
  })

  test("removes sessionTotals entry on idle", async () => {
    const { ctx } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(ctx.sessionTotals.has("ses_1")).toBe(true)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    expect(ctx.sessionTotals.has("ses_1")).toBe(false)
  })
})

describe("handleSessionDeleted", () => {
  test("records the session's net LOC once, diverging from the gross counter", async () => {
    const { ctx, counters, histograms } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 10, deletions: 0 }]), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 5, deletions: 5 }]), ctx)
    handleSessionDeleted(makeSessionDeleted("ses_1"), ctx)

    const added = histograms.sessionLinesTotal.calls.filter((c) => c.attrs["type"] === "added").map((c) => c.value)
    const removed = histograms.sessionLinesTotal.calls.filter((c) => c.attrs["type"] === "removed").map((c) => c.value)
    expect(added).toEqual([5])
    expect(removed).toEqual([5])

    const counterAdded = counters.lines.calls.filter((c) => c.attrs["type"] === "added").map((c) => c.value)
    expect(counterAdded).toEqual([10])
  })

  test("records exactly one observation pair for a multi-turn session", async () => {
    const { ctx, histograms } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 10, deletions: 0 }]), ctx)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 25, deletions: 0 }]), ctx)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    handleSessionDeleted(makeSessionDeleted("ses_1"), ctx)

    const added = histograms.sessionLinesTotal.calls.filter((c) => c.attrs["type"] === "added").map((c) => c.value)
    expect(added).toEqual([25])
    expect(added.reduce((a, b) => a + b, 0)).toBe(25)
  })

  test("carries common attributes and no session.id on the LOC histogram", async () => {
    const { ctx, histograms } = makeCtx("proj_test", [], [], true, { team: "platform" })
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 4, deletions: 1 }]), ctx)
    handleSessionDeleted(makeSessionDeleted("ses_1"), ctx)
    expect(histograms.sessionLinesTotal.calls).toHaveLength(2)
    for (const call of histograms.sessionLinesTotal.calls) {
      expect(call.attrs["project.id"]).toBe("proj_test")
      expect(call.attrs["team"]).toBe("platform")
      expect(call.attrs["session.id"]).toBeUndefined()
    }
  })

  test("does not record when the session saw no diff", async () => {
    const { ctx, histograms } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleSessionDeleted(makeSessionDeleted("ses_1"), ctx)
    expect(histograms.sessionLinesTotal.calls).toHaveLength(0)
  })

  test("does not record when session.lines_of_code.total is disabled", async () => {
    const { ctx, histograms } = makeCtx("proj_test", ["session.lines_of_code.total"])
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 4, deletions: 1 }]), ctx)
    handleSessionDeleted(makeSessionDeleted("ses_1"), ctx)
    expect(histograms.sessionLinesTotal.calls).toHaveLength(0)
  })

  test("does not record twice when error and deleted both fire", async () => {
    const { ctx, histograms } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 4, deletions: 1 }]), ctx)
    handleSessionError(makeSessionError("ses_1", { name: "Boom" }), ctx)
    handleSessionDeleted(makeSessionDeleted("ses_1"), ctx)
    expect(histograms.sessionLinesTotal.calls).toHaveLength(2)
  })

  test("ends a lingering session span for a deleted subagent session", async () => {
    const { ctx, tracer } = makeCtx()
    handleRunStarted("user_parent", "ses_parent", "build", "prompt", "anthropic/claude", 900, ctx)
    await handleSessionCreated(makeSessionCreated("ses_child", 1000, "ses_parent"), ctx)
    const childSpan = tracer.spans.find((s) => s.attributes["session.id"] === "ses_child")!
    handleSessionDeleted(makeSessionDeleted("ses_child"), ctx)
    expect(ctx.sessionSpans.has("ses_child")).toBe(false)
    expect(childSpan.ended).toBe(true)
  })

  test("ends a lingering run span when its session is deleted mid-run", async () => {
    const { ctx, tracer } = makeCtx()
    handleRunStarted("user_1", "ses_1", "build", "prompt", "anthropic/claude", 900, ctx)
    handleSessionDeleted(makeSessionDeleted("ses_1"), ctx)
    expect(ctx.runSpans.has("user_1")).toBe(false)
    expect(ctx.activeRuns.has("ses_1")).toBe(false)
    expect(tracer.spans[0]!.ended).toBe(true)
  })

  test("clears the session diff baseline so state does not leak", async () => {
    const { ctx } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 4, deletions: 1 }]), ctx)
    handleSessionDeleted(makeSessionDeleted("ses_1"), ctx)
    expect(ctx.sessionDiffTotals.has("ses_1")).toBe(false)
    expect(ctx.sessionTotals.has("ses_1")).toBe(false)
  })
})

describe("handleSessionError", () => {
  test("emits session.error log record", () => {
    const { ctx, logger } = makeCtx()
    handleSessionError(makeSessionError("ses_1", { name: "NetworkError" }), ctx)
    expect(logger.records).toHaveLength(1)
    const record = logger.records.at(0)!
    expect(record.body).toBe("session.error")
    expect(record.attributes?.["error"]).toBe("NetworkError")
  })

  test("defaults sessionID to 'unknown' when undefined", () => {
    const { ctx, logger } = makeCtx()
    handleSessionError({ type: "session.error", properties: {} } as unknown as EventSessionError, ctx)
    expect(logger.records.at(0)!.attributes?.["session.id"]).toBe("unknown")
  })

  test("sweeps pending maps on error", () => {
    const { ctx } = makeCtx()
    const t = makeTracer()
    const span = t.startSpan("tool") as unknown as Span
    ctx.pendingPermissions.set("perm_1", { type: "tool", title: "Read", sessionID: "ses_1" })
    ctx.pendingToolSpans.set("ses_1:call_1", { tool: "bash", sessionID: "ses_1", startMs: 0, span })
    handleSessionError(makeSessionError("ses_1"), ctx)
    expect(ctx.pendingPermissions.size).toBe(0)
    expect(ctx.pendingToolSpans.size).toBe(0)
  })

  test("removes sessionTotals entry on error when sessionID is known", async () => {
    const { ctx } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(ctx.sessionTotals.has("ses_1")).toBe(true)
    handleSessionError(makeSessionError("ses_1"), ctx)
    expect(ctx.sessionTotals.has("ses_1")).toBe(false)
  })

  test("does not delete sessionTotals when sessionID is undefined", async () => {
    const { ctx } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleSessionError({ type: "session.error", properties: {} } as unknown as EventSessionError, ctx)
    expect(ctx.sessionTotals.has("ses_1")).toBe(true)
  })
})

describe("handleSessionCreated — is_subagent", () => {
  test("tags session counter with is_subagent=false when no parentID", async () => {
    const { ctx, counters } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(counters.session.calls.at(0)!.attrs["is_subagent"]).toBe(false)
  })

  test("tags session counter with is_subagent=true when parentID is present", async () => {
    const { ctx, counters } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_child", 1000, "ses_parent"), ctx)
    expect(counters.session.calls.at(0)!.attrs["is_subagent"]).toBe(true)
  })

  test("includes is_subagent=false on session.created log record", async () => {
    const { ctx, logger } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(logger.records.at(0)!.attributes?.["is_subagent"]).toBe(false)
    expect(logger.records.at(0)!.attributes?.["agent.type"]).toBe("primary")
  })

  test("includes is_subagent=true on session.created log record for child session", async () => {
    const { ctx, logger } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_child", 1000, "ses_parent"), ctx)
    expect(logger.records.at(0)!.attributes?.["is_subagent"]).toBe(true)
    expect(logger.records.at(0)!.attributes?.["agent.type"]).toBe("subagent")
  })

  test("seeds sessionTotals agent metadata on creation", async () => {
    const { ctx } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(ctx.sessionTotals.get("ses_1")!.agent).toBe("unknown")
    expect(ctx.sessionTotals.get("ses_1")!.agentType).toBe("primary")
  })
})

describe("handleSessionStatus", () => {
  test("increments retry counter on retry status", () => {
    const { ctx, counters } = makeCtx()
    handleSessionStatus(makeSessionStatus("ses_1", { type: "retry", attempt: 1, message: "rate limited", next: 5000 }), ctx)
    expect(counters.retry.calls).toHaveLength(1)
    expect(counters.retry.calls.at(0)!.value).toBe(1)
    expect(counters.retry.calls.at(0)!.attrs["session.id"]).toBeUndefined()
  })

  test("ignores busy status", () => {
    const { ctx, counters } = makeCtx()
    handleSessionStatus(makeSessionStatus("ses_1", { type: "busy" }), ctx)
    expect(counters.retry.calls).toHaveLength(0)
  })

  test("ignores idle status", () => {
    const { ctx, counters } = makeCtx()
    handleSessionStatus(makeSessionStatus("ses_1", { type: "idle" }), ctx)
    expect(counters.retry.calls).toHaveLength(0)
  })
})
