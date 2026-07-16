import { describe, test, expect } from "bun:test"
import { handleSessionDiff, handleToolResult } from "../../src/handlers/activity.ts"
import { makeCtx } from "../helpers.ts"
import type { EventSessionDiff } from "@opencode-ai/sdk"

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
    // cumulative is added=5, removed=5 — the counter is GROSS, not net. Live
    // cumulative state is surfaced via linesTotalGauge (see next test).
    const { ctx, counters, gauges } = makeCtx()
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 10, deletions: 0 }]), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 5, deletions: 5 }]), ctx)

    const added = counters.lines.calls.filter((c) => c.attrs["type"] === "added").map((c) => c.value)
    const removed = counters.lines.calls.filter((c) => c.attrs["type"] === "removed").map((c) => c.value)
    expect(added).toEqual([10])
    expect(removed).toEqual([5])

    const gaugeAdded = gauges.linesTotal.calls.filter((c) => c.attrs["type"] === "added").map((c) => c.value)
    const gaugeRemoved = gauges.linesTotal.calls.filter((c) => c.attrs["type"] === "removed").map((c) => c.value)
    expect(gaugeAdded).toEqual([10, 5])
    expect(gaugeRemoved).toEqual([0, 5])
  })

  test("linesTotalGauge records cumulative totals, including zero after revert", () => {
    const { ctx, gauges } = makeCtx()
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 5, deletions: 2 }]), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 0, deletions: 0 }]), ctx)
    const added = gauges.linesTotal.calls.filter((c) => c.attrs["type"] === "added").map((c) => c.value)
    const removed = gauges.linesTotal.calls.filter((c) => c.attrs["type"] === "removed").map((c) => c.value)
    expect(added).toEqual([5, 0])
    expect(removed).toEqual([2, 0])
  })

  test("tracks deltas independently per session", () => {
    const { ctx, counters } = makeCtx()
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 3, deletions: 0 }]), ctx)
    handleSessionDiff(makeSessionDiff("ses_2", [{ file: "b.ts", additions: 7, deletions: 0 }]), ctx)
    handleSessionDiff(makeSessionDiff("ses_1", [{ file: "a.ts", additions: 5, deletions: 0 }]), ctx)
    const ses1 = counters.lines.calls.filter((c) => c.attrs["session.id"] === "ses_1").map((c) => c.value)
    const ses2 = counters.lines.calls.filter((c) => c.attrs["session.id"] === "ses_2").map((c) => c.value)
    expect(ses1).toEqual([3, 2])
    expect(ses2).toEqual([7])
  })
})

describe("handleToolResult", () => {
  test("increments commit counter for git commit in bash command", () => {
    const { ctx, counters } = makeCtx()
    handleToolResult("bash", { command: 'git commit -m "feat: add thing"', description: "Commit changes" }, "ses_1", ctx)
    expect(counters.commit.calls).toHaveLength(1)
    expect(counters.commit.calls.at(0)!.attrs["session.id"]).toBe("ses_1")
  })

  test("emits commit log record", () => {
    const { ctx, logger } = makeCtx()
    ctx.sessionTotals.set("ses_1", { startMs: 0, tokens: 0, cost: 0, messages: 0, agent: "build", agentType: "primary" })
    handleToolResult("bash", { command: "git commit -m 'fix: bug'", description: "" }, "ses_1", ctx)
    expect(logger.records).toHaveLength(1)
    expect(logger.records.at(0)!.body).toBe("commit")
    expect(logger.records.at(0)!.attributes?.["session.id"]).toBe("ses_1")
    expect(logger.records.at(0)!.attributes?.["agent.name"]).toBe("build")
    expect(logger.records.at(0)!.attributes?.["agent.type"]).toBe("primary")
  })

  test("ignores non-bash tools", () => {
    const { ctx, counters } = makeCtx()
    handleToolResult("read", { command: "git commit -m foo", description: "" }, "ses_1", ctx)
    expect(counters.commit.calls).toHaveLength(0)
  })

  test("ignores bash commands without git commit", () => {
    const { ctx, counters } = makeCtx()
    handleToolResult("bash", { command: "npm install", description: "Install deps" }, "ses_1", ctx)
    expect(counters.commit.calls).toHaveLength(0)
  })

  test("does not match git commit-graph", () => {
    const { ctx, counters } = makeCtx()
    handleToolResult("bash", { command: "git commit-graph write", description: "" }, "ses_1", ctx)
    expect(counters.commit.calls).toHaveLength(0)
  })

  test("matches when git commit appears in echo argument", () => {
    const { ctx, counters } = makeCtx()
    handleToolResult("bash", { command: 'echo "run git commit to save"', description: "" }, "ses_1", ctx)
    expect(counters.commit.calls).toHaveLength(1)
  })

  test("matches git commit with --amend", () => {
    const { ctx, counters } = makeCtx()
    handleToolResult("bash", { command: "git commit --amend --no-edit", description: "" }, "ses_1", ctx)
    expect(counters.commit.calls).toHaveLength(1)
  })

  test("matches when description contains git commit", () => {
    const { ctx, counters } = makeCtx()
    handleToolResult("bash", { command: "/usr/bin/env sh -c 'foo'", description: "git commit the changes" }, "ses_1", ctx)
    expect(counters.commit.calls).toHaveLength(1)
  })

  test("handles missing command and description fields", () => {
    const { ctx, counters } = makeCtx()
    handleToolResult("bash", {}, "ses_1", ctx)
    expect(counters.commit.calls).toHaveLength(0)
  })

  test("does not double-count when both fields match", () => {
    const { ctx, counters } = makeCtx()
    handleToolResult("bash", { command: "git commit -m foo", description: "git commit changes" }, "ses_1", ctx)
    expect(counters.commit.calls).toHaveLength(1)
  })
})
