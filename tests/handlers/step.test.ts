import { describe, test, expect } from "bun:test"
import { SpanStatusCode } from "@opentelemetry/api"
import { handleStepEnded, handleStepFailed, handleStepStarted, handleTextEnded } from "../../src/handlers/step.ts"
import { handleExecutionStarted, handleSessionCreated } from "../../src/handlers/session.ts"
import { makeCtx, evt, tokens } from "../helpers.ts"

function seedSession(ctx: ReturnType<typeof makeCtx>["ctx"], sessionID = "ses_1") {
  handleSessionCreated(evt("session.created", { sessionID, agent: "build" }), ctx)
  handleExecutionStarted(evt("session.execution.started", { sessionID }), ctx)
}

function stepStarted(sessionID = "ses_1", assistantMessageID = "msg_1") {
  return evt("session.step.started", {
    sessionID,
    assistantMessageID,
    agent: "build",
    model: { id: "claude-sonnet", providerID: "anthropic" },
    started: 1500,
  })
}

describe("handleStepStarted", () => {
  test("starts an LLM span parented to the run span", () => {
    const { ctx, tracer } = makeCtx()
    seedSession(ctx)
    handleStepStarted(stepStarted(), ctx)
    const llm = tracer.spans.find((s) => s.name === "opencode.llm")!
    const run = tracer.spans.find((s) => s.name === "opencode.session")!
    expect(llm.parentSpan).toBe(run)
    expect(llm.attributes["llm.model_name"]).toBe("claude-sonnet")
    expect(llm.attributes["gen_ai.provider.name"]).toBe("anthropic")
    expect(ctx.tracing.activeLlm.get("ses_1")!.providerID).toBe("anthropic")
  })
})

describe("handleStepEnded", () => {
  test("records token, cost, cache, message, and model metrics and ends the span", () => {
    const { ctx, tracer, counters, logger } = makeCtx()
    seedSession(ctx)
    handleStepStarted(stepStarted(), ctx)
    handleTextEnded(evt("session.text.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 1, text: "world" }), ctx)
    handleTextEnded(evt("session.text.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, text: "hello" }), ctx)
    handleStepEnded(
      evt("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0.25, tokens: tokens(10, 5, 2, 3, 0) }, 2000),
      ctx,
    )
    const tokenTypes = counters.token.calls.map((c) => c.attrs["type"])
    expect(tokenTypes).toEqual(["input", "output", "reasoning", "cacheRead", "cacheCreation"])
    expect(counters.cost.calls[0]!.value).toBe(0.25)
    expect(counters.cache.calls.map((c) => c.attrs["type"])).toEqual(["cacheRead"])
    expect(counters.message.calls).toHaveLength(1)
    expect(counters.modelUsage.calls[0]!.attrs["provider"]).toBe("anthropic")
    expect(logger.records.at(-1)!.body).toBe("api_request")
    const llm = tracer.spans.find((s) => s.name === "opencode.llm")!
    expect(llm.ended).toBe(true)
    expect(llm.status.code).toBe(SpanStatusCode.OK)
    expect(llm.attributes["llm.token_count.total"]).toBe(20)
    expect(llm.attributes["output.value"]).toBe("hello\nworld")
    expect(llm.attributes["llm.output_messages"]).toBe('[{"role":"assistant","content":"hello\\nworld"}]')
  })

  test("counts a message once across multiple steps", () => {
    const { ctx, counters } = makeCtx()
    seedSession(ctx)
    handleStepStarted(stepStarted(), ctx)
    handleStepEnded(evt("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "tool-calls", cost: 0.1, tokens: tokens() }), ctx)
    handleStepStarted(stepStarted(), ctx)
    handleStepEnded(evt("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0.1, tokens: tokens() }), ctx)
    expect(counters.message.calls).toHaveLength(1)
  })
})

describe("handleStepFailed", () => {
  test("records usage, ends the span with error, and emits api_error", () => {
    const { ctx, tracer, counters, logger } = makeCtx()
    seedSession(ctx)
    handleStepStarted(stepStarted(), ctx)
    handleStepFailed(
      evt("session.step.failed", { sessionID: "ses_1", assistantMessageID: "msg_1", error: { type: "ProviderError", message: "boom" }, cost: 0.1, tokens: tokens() }),
      ctx,
    )
    expect(counters.token.calls.length).toBeGreaterThan(0)
    const llm = tracer.spans.find((s) => s.name === "opencode.llm")!
    expect(llm.status.code).toBe(SpanStatusCode.ERROR)
    expect(llm.attributes["llm.token_count.total"]).toBe(15)
    expect(llm.attributes["llm.cost.total"]).toBe(0.1)
    expect(logger.records.at(-1)!.body).toBe("api_error")
    expect(logger.records.at(-1)!.attributes?.["error"]).toBe("ProviderError: boom")
    expect(counters.message.calls).toHaveLength(1)
    expect(counters.modelUsage.calls).toHaveLength(1)
  })

  test("records a failed step cost even when token usage is absent", () => {
    const { ctx, counters } = makeCtx()
    handleStepFailed(evt("session.step.failed", { sessionID: "s", assistantMessageID: "m", error: { type: "x", message: "y" }, cost: 2 }), ctx)
    expect(counters.cost.calls.map((call) => call.value)).toEqual([2])
  })
})

describe("API log durations", () => {
  test("records request and error latency without LLM traces", () => {
    const { ctx, logger, tracer } = makeCtx("proj_test", [], ["llm"])
    seedSession(ctx)
    handleStepStarted(stepStarted("ses_1", "msg_1"), ctx)
    handleStepEnded(evt("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0.1, tokens: tokens() }, 2000), ctx)
    handleStepStarted(stepStarted("ses_1", "msg_2"), ctx)
    handleStepFailed(evt("session.step.failed", { sessionID: "ses_1", assistantMessageID: "msg_2", error: { type: "x", message: "y" } }, 2400), ctx)
    expect(logger.records.find((record) => record.body === "api_request")?.attributes?.["duration_ms"]).toBe(500)
    expect(logger.records.find((record) => record.body === "api_error")?.attributes?.["duration_ms"]).toBe(900)
    expect(tracer.spans.some((span) => span.name === "opencode.llm")).toBe(false)
  })
})
