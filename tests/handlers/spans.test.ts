import { describe, test, expect } from "bun:test"
import { handleExecutionStarted, handleSessionCreated } from "../../src/handlers/session.ts"
import { handleStepStarted } from "../../src/handlers/step.ts"
import { handleToolInputStarted } from "../../src/handlers/tool.ts"
import { handleToolCalled } from "../../src/handlers/tool.ts"
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
})
