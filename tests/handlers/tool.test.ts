import { describe, test, expect } from "bun:test"
import { SpanStatusCode } from "@opentelemetry/api"
import { handleToolCalled, handleToolFailed, handleToolInputStarted, handleToolSuccess } from "../../src/handlers/tool.ts"
import { handleExecutionStarted, handleSessionCreated } from "../../src/handlers/session.ts"
import { makeCtx, evt } from "../helpers.ts"

function seed(ctx: ReturnType<typeof makeCtx>["ctx"], sessionID = "ses_1") {
  handleSessionCreated(evt("session.created", { sessionID, agent: "build" }), ctx)
  handleExecutionStarted(evt("session.execution.started", { sessionID }), ctx)
}

function inputStarted(id = "call_1", name = "bash", sessionID = "ses_1", created = 1000) {
  return evt("session.tool.input.started", { sessionID, assistantMessageID: "msg_1", id, name }, created)
}

describe("handleToolInputStarted", () => {
  test("stores the tool name without counting model input streaming as execution", () => {
    const { ctx, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted(), ctx)
    expect(tracer.spans.filter((s) => s.name.startsWith("opencode.tool."))).toHaveLength(0)
    expect(ctx.tracing.toolMeta.get("call_1")!.tool).toBe("bash")
  })
})

describe("handleToolCalled", () => {
  test("attaches parameters and detects a git commit", () => {
    const { ctx, counters, logger, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted(), ctx)
    handleToolCalled(evt("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: { command: "git commit -m 'x'" }, executed: true }), ctx)
    expect(counters.commit.calls).toHaveLength(0)
    handleToolSuccess(evt("session.tool.success", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", content: [{ type: "text", text: "commit made" }], executed: true }), ctx)
    expect(counters.commit.calls).toHaveLength(1)
    expect(logger.records.some((record) => record.body === "commit")).toBe(true)
    const span = tracer.spans.find((s) => s.name === "opencode.tool.bash")!
    expect(span.attributes["input.value"]).toContain("git commit")
  })

  test("ignores non-commit shell commands", () => {
    const { ctx, counters } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted(), ctx)
    handleToolCalled(evt("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: { command: "ls -la" }, executed: true }), ctx)
    expect(counters.commit.calls).toHaveLength(0)
  })

  test("does not count unexecuted or failed git commits", () => {
    const { ctx, counters } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted(), ctx)
    handleToolCalled(evt("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: { command: "git commit -m test" }, executed: false }), ctx)
    handleToolSuccess(evt("session.tool.success", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", content: [{ type: "text", text: "skipped" }], executed: false }), ctx)
    handleToolInputStarted(inputStarted("call_2"), ctx)
    handleToolCalled(evt("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_2", input: { command: "git commit -m test" }, executed: true }), ctx)
    handleToolFailed(evt("session.tool.failed", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_2", error: { type: "ToolError", message: "failed" }, executed: true }), ctx)
    expect(counters.commit.calls).toHaveLength(0)
  })
})

describe("handleToolSuccess", () => {
  test("records duration, sets output, and emits tool_result", () => {
    const { ctx, histograms, logger, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "read", "ses_1", 1000), ctx)
    handleToolCalled(evt("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: {}, executed: true }, 1000), ctx)
    handleToolSuccess(evt("session.tool.success", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", content: [{ type: "text", text: "file body" }], executed: true }, 1250), ctx)
    expect(histograms.tool.calls[0]!.value).toBe(250)
    expect(histograms.tool.calls[0]!.attrs["success"]).toBe(true)
    const record = logger.records.at(-1)!
    expect(record.body).toBe("tool_result")
    expect(record.attributes?.["duration_ms"]).toBe(250)
    const span = tracer.spans.find((s) => s.name === "opencode.tool.read")!
    expect(span.ended).toBe(true)
    expect(span.status.code).toBe(SpanStatusCode.OK)
    expect(span.attributes["output.value"]).toBe("file body")
  })
})

describe("handleToolFailed", () => {
  test("records an error result and ends the span with error", () => {
    const { ctx, histograms, logger, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted(), ctx)
    handleToolCalled(evt("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: {}, executed: true }, 1000), ctx)
    handleToolFailed(evt("session.tool.failed", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", error: { type: "ToolError", message: "nope" }, executed: true }, 1200), ctx)
    expect(histograms.tool.calls[0]!.attrs["success"]).toBe(false)
    expect(logger.records.at(-1)!.attributes?.["error"]).toBe("ToolError: nope")
    const span = tracer.spans.find((s) => s.name === "opencode.tool.bash")!
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
  })

  test("measures execution from called, excluding slow argument streaming", () => {
    const { ctx, histograms, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "read", "ses_1", 1000), ctx)
    handleToolCalled(evt("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: {}, executed: true }, 5000), ctx)
    handleToolSuccess(evt("session.tool.success", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", content: [{ type: "text", text: "ok" }], executed: true }, 5300), ctx)
    expect(histograms.tool.calls[0]!.value).toBe(300)
    expect(tracer.spans.find((span) => span.name === "opencode.tool.read")?.startTime).toBe(5000)
  })

  test("does not create a dispatch span for an invalid subagent call without a child", () => {
    const { ctx, tracer, histograms } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_2", "subagent"), ctx)
    handleToolCalled(evt("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_2", input: { agent: "explore" }, executed: false }), ctx)
    handleToolFailed(evt("session.tool.failed", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_2", error: { type: "invalid", message: "missing input" }, executed: false }), ctx)
    expect(tracer.spans.some((span) => span.name === "opencode.tool.subagent")).toBe(false)
    expect(histograms.tool.calls).toHaveLength(0)
  })
})
