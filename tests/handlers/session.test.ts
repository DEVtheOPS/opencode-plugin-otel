import { describe, test, expect } from "bun:test"
import { SpanStatusCode } from "@opentelemetry/api"
import {
  finalizeSession,
  handleExecutionEnded,
  handleExecutionStarted,
  handlePromptEnqueued,
  handleSessionCreated,
  handleSessionIdle,
  handleSessionStatus,
  handleRetryScheduled,
  handleUsageUpdated,
} from "../../src/handlers/session.ts"
import { makeCtx, evt, tokens } from "../helpers.ts"

describe("handleSessionCreated", () => {
  test("increments the session counter and stores totals", () => {
    const { ctx, counters } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1", created: 1000, projectID: "proj_test", location: {}, slug: "s", version: "1" }), ctx)
    expect(counters.session.calls).toHaveLength(1)
    expect(counters.session.calls[0]!.attrs["session.id"]).toBe("ses_1")
    expect(counters.session.calls[0]!.attrs["is_subagent"]).toBe(false)
    const totals = ctx.tracing.sessionTotals.get("ses_1")!
    expect(totals.startMs).toBe(1000)
    expect(totals.agentType).toBe("primary")
  })

  test("marks subagent sessions and increments the subtask counter", () => {
    const { ctx, counters, logger } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "sub_1", parentID: "ses_1", agent: "explore" }), ctx)
    expect(counters.session.calls[0]!.attrs["is_subagent"]).toBe(true)
    expect(counters.subtask.calls).toHaveLength(1)
    expect(ctx.tracing.sessionTotals.get("sub_1")!.parentID).toBe("ses_1")
    expect(logger.records[0]!.attributes?.["agent.name"]).toBe("explore")
    expect(logger.records.some((record) => record.body === "subtask_invoked")).toBe(true)
  })
})

describe("handlePromptEnqueued", () => {
  test("logs admitted user prompts and stores their text for spans", () => {
    const { ctx, logger } = makeCtx()
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "ses_1",
      inboxID: "msg_1",
      item: { type: "user", payload: { text: "hello", files: [], agents: [], skills: [] }, delivery: "queue" },
    }), ctx, false)
    expect(logger.records[0]!.body).toBe("user_prompt")
    expect(logger.records[0]!.attributes?.["delivery"]).toBe("queue")
    expect(logger.records[0]!.attributes?.["prompt"]).toBeUndefined()
    expect(ctx.tracing.pendingPrompts.get("ses_1")!.text).toBe("hello")
  })

  test("skips non-user inbox items", () => {
    const { ctx, logger } = makeCtx()
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "ses_1", inboxID: "msg_2", item: { type: "synthetic", payload: { text: "hidden" }, delivery: "steer" },
    }), ctx, true)
    expect(logger.records).toHaveLength(0)
  })
})

describe("handleExecutionStarted", () => {
  test("starts a run span and attaches the pending prompt", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }), ctx)
    ctx.tracing.pendingPrompts.set("ses_1", { text: "hello", startMs: 1 })
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }, 2000), ctx)
    const span = tracer.spans[0]!
    expect(span.name).toBe("opencode.session")
    expect(span.startTime).toBe(2000)
    expect(span.attributes["input.value"]).toBe("hello")
    expect(ctx.tracing.runSpans.has("ses_1")).toBe(true)
    expect(ctx.tracing.pendingPrompts.get("ses_1")!.text).toBe("hello")
  })

  test("nests subagent runs under the parent run span", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }, 100), ctx)
    handleSessionCreated(evt("session.created", { sessionID: "sub_1", parentID: "ses_1" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "sub_1" }, 200), ctx)
    const parentRun = tracer.spans.find((s) => s.attributes["session.id"] === "ses_1")!
    const subRun = tracer.spans.find((s) => s.attributes["session.id"] === "sub_1")!
    expect(subRun.parentSpan).toBe(parentRun)
  })

  test("lazily initializes and counts a session with no session.created event", () => {
    const { ctx, counters } = makeCtx()
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_new" }, 100), ctx)
    expect(ctx.tracing.sessionTotals.has("ses_new")).toBe(true)
    expect(counters.session.calls).toHaveLength(1)
  })
})

describe("handleExecutionEnded", () => {
  test("ends the run span OK and records totals", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1", agent: "build" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    handleExecutionEnded(evt("session.execution.succeeded", { sessionID: "ses_1" }, 5000), ctx, { type: "succeeded" })
    const span = tracer.spans[0]!
    expect(span.ended).toBe(true)
    expect(span.endTime).toBe(5000)
    expect(span.status.code).toBe(SpanStatusCode.OK)
    expect(span.attributes["agent.name"]).toBe("build")
  })

  test("failed execution ends the span with an error and emits session.error", () => {
    const { ctx, tracer, logger } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    handleExecutionEnded(
      evt("session.execution.failed", { sessionID: "ses_1", error: { type: "ProviderError", message: "boom" } }),
      ctx,
      { type: "failed", error: { type: "ProviderError", message: "boom" } },
    )
    expect(tracer.spans[0]!.status.code).toBe(SpanStatusCode.ERROR)
    expect(logger.records.at(-1)!.body).toBe("session.error")
    expect(logger.records.at(-1)!.attributes?.["error"]).toBe("ProviderError: boom")
  })
})

describe("handleSessionStatus", () => {
  test("counts durable retry events once rather than retry status", () => {
    const { ctx, counters } = makeCtx()
    handleSessionStatus(evt("session.status", { sessionID: "ses_1", status: { type: "retry", attempt: 1, message: "m", next: 2 } }), ctx)
    expect(counters.retry.calls).toHaveLength(0)
    handleRetryScheduled(evt("session.retry.scheduled", { sessionID: "ses_1", assistantMessageID: "m", attempt: 1, at: 2, error: { type: "x", message: "y" } }), ctx)
    expect(counters.retry.calls).toHaveLength(1)
  })

  test("idle records duration and session totals then clears state", () => {
    const { ctx, histograms, logger } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }, 100), ctx)
    ctx.tracing.sessionTotals.set("ses_1", { startMs: 100, tokens: 42, cost: 0.5, messages: 3, agent: "build", agentType: "primary" })
    handleSessionStatus(evt("session.status", { sessionID: "ses_1", status: { type: "idle" } }), ctx)
    expect(histograms.sessionDuration.calls).toHaveLength(1)
    expect(histograms.sessionToken.calls[0]!.value).toBe(42)
    expect(histograms.sessionCost.calls[0]!.value).toBe(0.5)
    expect(logger.records.at(-1)!.body).toBe("session.idle")
    expect(ctx.tracing.sessionTotals.has("ses_1")).toBe(false)
  })
})

describe("handleUsageUpdated", () => {
  test("stores cumulative tokens including cache", () => {
    const { ctx } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }), ctx)
    handleUsageUpdated(evt("session.usage.updated", { sessionID: "ses_1", cost: 1.25, tokens: tokens(10, 5, 2, 3, 4) }), ctx)
    const totals = ctx.tracing.sessionTotals.get("ses_1")!
    expect(totals.tokens).toBe(24)
    expect(totals.cost).toBe(1.25)
  })
})

describe("handleSessionIdle", () => {
  test("finalizes via the deprecated idle event", () => {
    const { ctx, logger } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }, 100), ctx)
    handleSessionIdle(evt("session.idle", { sessionID: "ses_1" }), ctx)
    expect(logger.records.at(-1)!.body).toBe("session.idle")
  })

  test("finalizeSession is idempotent", () => {
    const { ctx, histograms } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }, 100), ctx)
    finalizeSession("ses_1", ctx)
    finalizeSession("ses_1", ctx)
    expect(histograms.sessionDuration.calls).toHaveLength(1)
  })
})
