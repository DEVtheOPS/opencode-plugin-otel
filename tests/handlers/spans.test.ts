import { describe, test, expect } from "bun:test"
import { finalizeSession, handleExecutionEnded, handleExecutionStarted, handleSessionCreated } from "../../src/handlers/session.ts"
import { handleStepStarted } from "../../src/handlers/step.ts"
import { handleToolInputStarted } from "../../src/handlers/tool.ts"
import { handleToolCalled } from "../../src/handlers/tool.ts"
import { handleToolProgress, handleToolSuccess } from "../../src/handlers/tool.ts"
import { makeCtx, evt } from "../helpers.ts"

describe("trace nesting", () => {
  test("run -> step -> tool spans form a single chain", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "ses_1", agent: "build" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "ses_1" }), ctx)
    handleStepStarted(
      evt("session.step.started", { sessionID: "ses_1", assistantMessageID: "msg_1", agent: "build", model: { id: "m", providerID: "anthropic" } }),
      ctx,
    )
    handleToolInputStarted(evt("session.tool.input.started", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", name: "read" }), ctx)
    handleToolCalled(evt("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: {}, executed: true }), ctx)

    const run = tracer.spans.find((s) => s.name === "opencode.session")!
    const step = tracer.spans.find((s) => s.name === "opencode.llm")!
    const tool = tracer.spans.find((s) => s.name === "opencode.tool.read")!
    expect(run.parentSpan).toBeUndefined()
    expect(step.parentSpan).toBe(run)
    expect(tool.parentSpan).toBe(step)
  })

  test("nests a foreground child under the unique live subagent dispatch span", () => {
    const { ctx, tracer, histograms } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "parent", projectID: "p" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "parent" }), ctx)
    handleToolInputStarted(evt("session.tool.input.started", { sessionID: "parent", assistantMessageID: "m", id: "call_1", name: "subagent" }, 1000), ctx)
    handleToolCalled(evt("session.tool.called", { sessionID: "parent", assistantMessageID: "m", id: "call_1", input: { agent: "explore" }, executed: false }, 1500), ctx)
    handleSessionCreated(evt("session.created", { sessionID: "child", projectID: "p", parentID: "parent", agent: "explore" }), ctx)
    handleToolProgress(evt("session.tool.progress", { sessionID: "parent", assistantMessageID: "m", id: "call_1", metadata: { sessionID: "child" } }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "child" }, 1700), ctx)
    const tool = tracer.spans.find((span) => span.name === "opencode.tool.subagent")!
    const child = tracer.spans.find((span) => span.attributes["session.id"] === "child")!
    expect(child.parentSpanContext?.spanId).toBe(tool.spanContext().spanId)
    handleToolSuccess(evt("session.tool.success", { sessionID: "parent", assistantMessageID: "m", id: "call_1", content: [{ type: "text", text: "done" }], metadata: { sessionID: "child" }, executed: false }, 1900), ctx)
    expect(histograms.tool.calls.at(-1)?.value).toBe(400)
    expect(ctx.tracing.consumedSubagentDispatches.has("call_1")).toBe(true)
    expect(ctx.tracing.subagentParents.has("child")).toBe(false)
    expect(tool.attributes["subagent.session_id"]).toBe("child")
  })

  test("nests a background child under the dispatch context after the tool ends", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "parent", projectID: "p" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "parent" }), ctx)
    handleToolInputStarted(evt("session.tool.input.started", { sessionID: "parent", assistantMessageID: "m", id: "call_1", name: "subagent" }), ctx)
    handleToolCalled(evt("session.tool.called", { sessionID: "parent", assistantMessageID: "m", id: "call_1", input: { agent: "explore", background: true }, executed: false }), ctx)
    handleToolProgress(evt("session.tool.progress", { sessionID: "parent", assistantMessageID: "m", id: "call_1", metadata: { sessionID: "child" } }), ctx)
    handleToolSuccess(evt("session.tool.success", { sessionID: "parent", assistantMessageID: "m", id: "call_1", content: [{ type: "text", text: "launched" }], metadata: { sessionID: "child" }, executed: false }), ctx)
    handleSessionCreated(evt("session.created", { sessionID: "child", projectID: "p", parentID: "parent", agent: "explore" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "child" }), ctx)
    const tool = tracer.spans.find((span) => span.name === "opencode.tool.subagent")!
    const child = tracer.spans.find((span) => span.attributes["session.id"] === "child")!
    expect(child.parentSpanContext?.spanId).toBe(tool.spanContext().spanId)
  })

  test("falls back to the parent run when two dispatch candidates are ambiguous", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "parent", projectID: "p" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "parent" }), ctx)
    for (const id of ["a", "b"]) {
      handleToolInputStarted(evt("session.tool.input.started", { sessionID: "parent", assistantMessageID: "m", id, name: "subagent" }), ctx)
      handleToolCalled(evt("session.tool.called", { sessionID: "parent", assistantMessageID: "m", id, input: { agent: "explore" }, executed: true }), ctx)
    }
    handleSessionCreated(evt("session.created", { sessionID: "child", projectID: "p", parentID: "parent", agent: "explore" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "child" }), ctx)
    const parent = tracer.spans.find((span) => span.name === "opencode.session" && span.attributes["session.id"] === "parent")!
    const child = tracer.spans.find((span) => span.name === "opencode.session" && span.attributes["session.id"] === "child")!
    expect(child.parentSpan).toBe(parent)
  })

  test("does not reuse an earlier dispatch when the child executes again", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "parent", projectID: "p" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "parent" }), ctx)
    handleToolInputStarted(evt("session.tool.input.started", { sessionID: "parent", assistantMessageID: "m", id: "call_1", name: "subagent" }), ctx)
    handleToolCalled(evt("session.tool.called", { sessionID: "parent", assistantMessageID: "m", id: "call_1", input: { agent: "explore" }, executed: false }), ctx)
    handleToolProgress(evt("session.tool.progress", { sessionID: "parent", assistantMessageID: "m", id: "call_1", metadata: { sessionID: "child" } }), ctx)
    handleSessionCreated(evt("session.created", { sessionID: "child", projectID: "p", parentID: "parent", agent: "explore" }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "child" }), ctx)
    handleExecutionEnded(evt("session.execution.succeeded", { sessionID: "child" }), ctx, { type: "succeeded" })
    finalizeSession("child", ctx)
    handleToolSuccess(evt("session.tool.success", { sessionID: "parent", assistantMessageID: "m", id: "call_1", content: [{ type: "text", text: "done" }], metadata: { sessionID: "child" }, executed: false }), ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "child" }), ctx)
    const parent = tracer.spans.find((span) => span.name === "opencode.session" && span.attributes["session.id"] === "parent")!
    const resumed = tracer.spans.filter((span) => span.name === "opencode.session" && span.attributes["session.id"] === "child").at(-1)!
    expect(resumed.parentSpan).toBe(parent)
  })
})
