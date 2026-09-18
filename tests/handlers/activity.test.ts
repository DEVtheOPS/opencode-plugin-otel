import { describe, test, expect } from "bun:test"
import { handleSessionDiff, handleCommandExecuted } from "../../src/handlers/activity.ts"
import { makeCtx } from "../helpers.ts"
import type { EventSessionDiff, EventCommandExecuted } from "@opencode-ai/sdk"

function makeSessionDiff(
  sessionID: string,
  diffs: Array<{ file: string; additions: number; deletions: number }>,
): EventSessionDiff {
  return {
    type: "session.diff",
    properties: {
      sessionID,
      diff: diffs.map((d) => ({ before: "", after: "", additions: d.additions, deletions: d.deletions, file: d.file })),
    },
  } as unknown as EventSessionDiff
}

function makeCommandExecuted(name: string, args: string, sessionID = "ses_1"): EventCommandExecuted {
  return {
    type: "command.executed",
    properties: { name, arguments: args, sessionID, messageID: "msg_1" },
  } as unknown as EventCommandExecuted
}

describe("handleSessionDiff", () => {
  test("increments linesCounter for additions", () => {
    const { ctx, counters } = makeCtx()
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "foo.ts", additions: 10, deletions: 0 }]), ctx)
    expect(counters.lines.calls).toHaveLength(1)
    expect(counters.lines.calls.at(0)!.value).toBe(10)
    expect(counters.lines.calls.at(0)!.attrs["type"]).toBe("added")
  })

  test("increments linesCounter for deletions", () => {
    const { ctx, counters } = makeCtx()
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "foo.ts", additions: 0, deletions: 5 }]), ctx)
    expect(counters.lines.calls).toHaveLength(1)
    expect(counters.lines.calls.at(0)!.value).toBe(5)
    expect(counters.lines.calls.at(0)!.attrs["type"]).toBe("removed")
  })

  test("increments both added and removed for mixed diffs", () => {
    const { ctx, counters } = makeCtx()
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "foo.ts", additions: 8, deletions: 3 }]), ctx)
    expect(counters.lines.calls).toHaveLength(2)
    const types = counters.lines.calls.map((c) => c.attrs["type"])
    expect(types).toContain("added")
    expect(types).toContain("removed")
  })

  test("handles multiple files", () => {
    const { ctx, counters } = makeCtx()
    handleSessionDiff(
      makeSessionDiff("ses_1", [
        { file: "a.ts", additions: 5, deletions: 0 },
        { file: "b.ts", additions: 3, deletions: 2 },
      ]),
      ctx,
    )
    const totalAdded = counters.lines.calls
      .filter((c) => c.attrs["type"] === "added")
      .reduce((sum, c) => sum + c.value, 0)
    expect(totalAdded).toBe(8)
  })

  test("skips zero additions", () => {
    const { ctx, counters } = makeCtx()
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "foo.ts", additions: 0, deletions: 0 }]), ctx)
    expect(counters.lines.calls).toHaveLength(0)
  })

  test("linesCounter emits only positive deltas across multiple events", () => {
    const { ctx, counters } = makeCtx()
    // opencode publishes session.diff with the CUMULATIVE session total every event.
    // Cumulative sequence: 4, 9, 9, 11.  Expected deltas: 4, 5, 0 (skipped), 2.
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 4, deletions: 0 }]), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 9, deletions: 0 }]), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 9, deletions: 0 }]), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 11, deletions: 0 }]), ctx)
    const added = counters.lines.calls.filter((c) => c.attrs["type"] === "added").map((c) => c.value)
    expect(added).toEqual([4, 5, 2])
    expect(added.reduce((a, b) => a + b, 0)).toBe(11) // net, not 4+9+9+11=33
  })

  test("linesCounter skips negative deltas (revert-to-baseline)", () => {
    const { ctx, counters } = makeCtx()
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 5, deletions: 0 }]), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 0, deletions: 0 }]), ctx)
    const added = counters.lines.calls.filter((c) => c.attrs["type"] === "added").map((c) => c.value)
    expect(added).toEqual([5])
  })

  test("linesCounter is gross-only across a partial revert (additions shrink, deletions grow)", () => {
    // Cumulative goes {additions:10, deletions:0} -> {additions:5, deletions:5}.
    // Delta is {added:-5, removed:+5}. Negative added is skipped; positive removed
    // is emitted. Counter ends at added=10, removed=5 while the authoritative live
    // cumulative is added=5, removed=5 — the counter is GROSS, not net. The net
    // per-session values are surfaced by session.lines_of_code.total on session.idle.
    const { ctx, counters } = makeCtx()
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 10, deletions: 0 }]), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 5, deletions: 5 }]), ctx)

    const added = counters.lines.calls.filter((c) => c.attrs["type"] === "added").map((c) => c.value)
    const removed = counters.lines.calls.filter((c) => c.attrs["type"] === "removed").map((c) => c.value)
    expect(added).toEqual([10])
    expect(removed).toEqual([5])
    expect(ctx.sessionDiffTotals.get("ses_1")).toEqual({ additions: 5, deletions: 5 })
  })

  test("tracks deltas independently per session", () => {
    const { ctx, counters } = makeCtx()
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 3, deletions: 0 }]), ctx)
    handleSessionDiff(makeSessionDiff("ses_2", [{ file: "b.ts", additions: 7, deletions: 0 }]), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 5, deletions: 0 }]), ctx)
    const added = counters.lines.calls.filter((c) => c.attrs["type"] === "added").map((c) => c.value)
    expect(added).toEqual([3, 7, 2])
    expect(ctx.sessionDiffTotals.get("ses_1")).toEqual({ additions: 5, deletions: 0 })
    expect(ctx.sessionDiffTotals.get("ses_2")).toEqual({ additions: 7, deletions: 0 })
  })
})

describe("handleCommandExecuted", () => {
  test("increments commit counter for git commit", () => {
    const { ctx, counters } = makeCtx()
    handleCommandExecuted(makeCommandExecuted("bash", 'git commit -m "feat: add thing"'), ctx)
    expect(counters.commit.calls).toHaveLength(1)
  })

  test("emits commit log record", () => {
    const { ctx, logger } = makeCtx()
    ctx.sessionTotals.set("ses_1", { startMs: 0, tokens: 0, cost: 0, messages: 0, agent: "build", agentType: "primary" })
    handleCommandExecuted(makeCommandExecuted("bash", "git commit -m 'fix: bug'"), ctx)
    expect(logger.records).toHaveLength(1)
    expect(logger.records.at(0)!.body).toBe("commit")
    expect(logger.records.at(0)!.attributes?.["session.id"]).toBe("ses_1")
    expect(logger.records.at(0)!.attributes?.["agent.name"]).toBe("build")
    expect(logger.records.at(0)!.attributes?.["agent.type"]).toBe("primary")
  })

  test("ignores non-bash commands", () => {
    const { ctx, counters } = makeCtx()
    handleCommandExecuted(makeCommandExecuted("python", "git commit -m foo"), ctx)
    expect(counters.commit.calls).toHaveLength(0)
  })

  test("ignores bash commands without git commit", () => {
    const { ctx, counters } = makeCtx()
    handleCommandExecuted(makeCommandExecuted("bash", "npm install"), ctx)
    expect(counters.commit.calls).toHaveLength(0)
  })

  test("does not match git commit-graph", () => {
    const { ctx, counters } = makeCtx()
    handleCommandExecuted(makeCommandExecuted("bash", "git commit-graph write"), ctx)
    expect(counters.commit.calls).toHaveLength(0)
  })

  test("does not match string containing 'git commit' in echo", () => {
    const { ctx, counters } = makeCtx()
    handleCommandExecuted(makeCommandExecuted("bash", 'echo "run git commit to save"'), ctx)
    expect(counters.commit.calls).toHaveLength(1)
  })

  test("matches git commit with --amend", () => {
    const { ctx, counters } = makeCtx()
    handleCommandExecuted(makeCommandExecuted("bash", "git commit --amend --no-edit"), ctx)
    expect(counters.commit.calls).toHaveLength(1)
  })
})
