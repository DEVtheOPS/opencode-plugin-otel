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
  test("starts a tool span named after the tool", () => {
    const { ctx, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted(), ctx)
    const span = tracer.spans.find((s) => s.name.startsWith("opencode.tool."))!
    expect(span.name).toBe("opencode.tool.bash")
    expect(ctx.tracing.toolMeta.get("call_1")!.tool).toBe("bash")
  })
})

describe("handleToolCalled", () => {
  test("attaches parameters and detects a git commit", () => {
    const { ctx, counters, logger, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted(), ctx)
    handleToolCalled(evt("session.tool.called", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", input: { command: "git commit -m 'x'" }, executed: true }), ctx)
    expect(counters.commit.calls).toHaveLength(1)
    expect(logger.records.at(-1)!.body).toBe("commit")
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
})

describe("handleToolSuccess", () => {
  test("records duration, sets output, and emits tool_result", () => {
    const { ctx, histograms, logger, tracer } = makeCtx()
    seed(ctx)
    handleToolInputStarted(inputStarted("call_1", "read", "ses_1", 1000), ctx)
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
    handleToolFailed(evt("session.tool.failed", { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", error: { type: "ToolError", message: "nope" }, executed: true }, 1200), ctx)
    expect(histograms.tool.calls[0]!.attrs["success"]).toBe(false)
    expect(logger.records.at(-1)!.attributes?.["error"]).toBe("ToolError: nope")
    const span = tracer.spans.find((s) => s.name === "opencode.tool.bash")!
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
  })
})
