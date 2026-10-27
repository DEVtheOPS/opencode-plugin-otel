import { describe, test, expect } from "bun:test"
import { handleExecutionStarted, handleSessionCreated, handleSessionStatus, handleUsageUpdated, finalizeSession } from "../../src/handlers/session.ts"
import { handleStepEnded, handleStepStarted } from "../../src/handlers/step.ts"
import { handleToolCalled, handleToolInputStarted, handleToolSuccess } from "../../src/handlers/tool.ts"
import { makeCtx, evt, tokens } from "../helpers.ts"

describe("disabled metrics", () => {
  test("suppresses individual counters", () => {
    const { ctx, counters } = makeCtx("proj_test", ["session.count", "token.usage", "cost.usage", "cache.count", "message.count", "model.usage", "subtask.count"])
    handleSessionCreated(evt("session.created", { sessionID: "ses_1", parentID: "p" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    handleStepStarted(evt("session.step.started", { sessionID: "ses_1", assistantMessageID: "m", agent: "build", model: { id: "x", providerID: "anthropic" } }), ctx)
    handleStepEnded(evt("session.step.ended", { sessionID: "ses_1", assistantMessageID: "m", finish: "stop", cost: 1, tokens: tokens(1, 1, 1, 1, 1) }), ctx)
    expect(counters.session.calls).toHaveLength(0)
    expect(counters.token.calls).toHaveLength(0)
    expect(counters.cost.calls).toHaveLength(0)
    expect(counters.cache.calls).toHaveLength(0)
    expect(counters.message.calls).toHaveLength(0)
    expect(counters.modelUsage.calls).toHaveLength(0)
    expect(counters.subtask.calls).toHaveLength(0)
  })

  test("suppresses retry and session total histograms", () => {
    const { ctx, counters, histograms } = makeCtx("proj_test", ["retry.count", "session.duration", "session.token.total", "session.cost.total"])
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }), ctx)
    handleSessionStatus(evt("session.status", { sessionID: "ses_1", status: { type: "retry", attempt: 1, message: "m", next: 1 } }), ctx)
    handleUsageUpdated(evt("session.usage.updated", { sessionID: "ses_1", cost: 1, tokens: tokens() }), ctx)
    finalizeSession("ses_1", ctx)
    expect(counters.retry.calls).toHaveLength(0)
    expect(histograms.sessionDuration.calls).toHaveLength(0)
    expect(histograms.sessionToken.calls).toHaveLength(0)
    expect(histograms.sessionCost.calls).toHaveLength(0)
  })
})

describe("disabled traces", () => {
  test("session spans can be disabled", () => {
    const { ctx, tracer } = makeCtx("proj_test", [], ["session"])
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    expect(tracer.spans).toHaveLength(0)
  })

  test("llm spans can be disabled", () => {
    const { ctx, tracer } = makeCtx("proj_test", [], ["llm"])
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    handleStepStarted(evt("session.step.started", { sessionID: "ses_1", assistantMessageID: "m", agent: "build", model: { id: "x", providerID: "anthropic" } }), ctx)
    expect(tracer.spans.map((s) => s.name)).toEqual(["opencode.session"])
  })

  test("tool spans can be disabled without disabling tool metrics or commit detection", () => {
    const { ctx, tracer, counters, histograms, logger } = makeCtx("proj_test", [], ["tool"])
    handleSessionCreated(evt("session.created", { sessionID: "ses_1" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    const call = { sessionID: "ses_1", assistantMessageID: "m", id: "c", executed: false }
    handleToolInputStarted(evt("session.tool.input.started", { ...call, name: "shell" }, 1000), ctx)
    handleToolCalled(evt("session.tool.called", { ...call, input: { command: "git commit -m 'test'" } }, 2000), ctx)
    expect(tracer.spans.map((s) => s.name)).toEqual(["opencode.session"])
    expect(counters.commit.calls).toHaveLength(0)
    expect(logger.records.filter((record) => record.body === "commit")).toHaveLength(0)
    handleToolSuccess(evt("session.tool.success", { ...call, content: [{ type: "text", text: "committed" }] }, 2250), ctx)
    expect(tracer.spans.map((s) => s.name)).toEqual(["opencode.session"])
    expect(histograms.tool.calls).toHaveLength(1)
    expect(histograms.tool.calls[0]!.value).toBe(250)
    expect(histograms.tool.calls[0]!.attrs).toMatchObject({ tool_name: "shell", success: true })
    const toolResults = logger.records.filter((record) => record.body === "tool_result")
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0]!.attributes?.["duration_ms"]).toBe(250)
    expect(counters.commit.calls).toHaveLength(1)
    expect(counters.commit.calls[0]!.value).toBe(1)
    expect(logger.records.filter((record) => record.body === "commit")).toHaveLength(1)
  })
})
