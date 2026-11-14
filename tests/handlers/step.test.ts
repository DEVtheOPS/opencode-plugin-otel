import { describe, test, expect } from "bun:test"
import { SpanStatusCode } from "@opentelemetry/api"
import { handleStepEnded, handleStepFailed, handleStepStarted, handleTextEnded } from "../../src/handlers/step.ts"
import { finalizeSession, handleExecutionEnded, handleExecutionStarted, handleSessionCreated } from "../../src/handlers/session.ts"
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

  test("reports reasoning separately from output by default", () => {
    const { ctx, tracer, counters, logger } = makeCtx()
    seedSession(ctx)
    handleStepStarted(stepStarted(), ctx)
    handleStepEnded(evt("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0, tokens: tokens(10, 5, 2) }), ctx)
    const byType = Object.fromEntries(counters.token.calls.map((c) => [c.attrs["type"], c.value]))
    expect(byType["output"]).toBe(5)
    expect(byType["reasoning"]).toBe(2)
    const attrs = logger.records.at(-1)!.attributes!
    expect(attrs["output_tokens"]).toBe(5)
    expect(attrs["reasoning_tokens"]).toBe(2)
    expect(tracer.spans.find((s) => s.name === "opencode.llm")!.attributes["llm.token_count.completion"]).toBe(5)
  })

  test("folds reasoning into output when combineReasoningTokens is enabled", () => {
    const { ctx, tracer, counters, logger } = makeCtx("proj_test", [], [], true, {}, true)
    seedSession(ctx)
    handleStepStarted(stepStarted(), ctx)
    handleStepEnded(evt("session.step.ended", { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0, tokens: tokens(10, 5, 2, 3, 1) }), ctx)
    const tokenTypes = counters.token.calls.map((c) => c.attrs["type"])
    expect(tokenTypes).toEqual(["input", "output", "cacheRead", "cacheCreation"])
    expect(counters.token.calls.find((c) => c.attrs["type"] === "output")!.value).toBe(7)
    const attrs = logger.records.at(-1)!.attributes!
    expect(attrs["output_tokens"]).toBe(7)
    expect(attrs).not.toHaveProperty("reasoning_tokens")
    const llm = tracer.spans.find((s) => s.name === "opencode.llm")!
    expect(llm.attributes["llm.token_count.completion"]).toBe(7)
    expect(llm.attributes["llm.token_count.completion_details.reasoning"]).toBe(2)
    expect(llm.attributes["llm.token_count.total"]).toBe(21)
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

describe("step model fallback", () => {
  function ended(assistantMessageID = "msg_2") {
    return evt("session.step.ended", { sessionID: "ses_1", assistantMessageID, finish: "stop", cost: 0, tokens: tokens() })
  }

  test("uses the session's last model when the step start was missed", () => {
    const { ctx, logger, counters } = makeCtx()
    seedSession(ctx)
    handleStepStarted(stepStarted("ses_1", "msg_1"), ctx)
    handleStepEnded(ended("msg_1"), ctx)
    handleStepEnded(ended("msg_2"), ctx)
    const request = logger.records.at(-1)!
    expect(request.attributes?.["model"]).toBe("claude-sonnet")
    expect(request.attributes?.["provider"]).toBe("anthropic")
    expect(counters.token.calls.at(-1)!.attrs["model"]).toBe("claude-sonnet")
  })

  test("keeps the model of a step that ends after its execution was swept", () => {
    const { ctx, logger } = makeCtx()
    seedSession(ctx)
    handleStepStarted(stepStarted("ses_1", "msg_1"), ctx)
    handleExecutionEnded(evt("session.execution.interrupted", { sessionID: "ses_1", reason: "user" }), ctx, { type: "interrupted", reason: "user" })
    finalizeSession("ses_1", ctx)
    handleStepEnded(ended("msg_1"), ctx)
    expect(logger.records.find((record) => record.body === "api_request")?.attributes?.["model"]).toBe("claude-sonnet")
  })

  test("uses the in-flight model request when the step start was missed", () => {
    const { ctx, logger } = makeCtx()
    seedSession(ctx)
    ctx.tracing.activeLlm.set("ses_1", {
      agent: "build",
      modelID: "gpt-5",
      providerID: "openai",
      spanContext: { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 1 },
    })
    handleStepFailed(evt("session.step.failed", { sessionID: "ses_1", assistantMessageID: "msg_2", error: { type: "x", message: "y" } }), ctx)
    expect(logger.records.at(-1)!.attributes?.["model"]).toBe("gpt-5")
    expect(logger.records.at(-1)!.attributes?.["provider"]).toBe("openai")
  })

  test("reports unknown when nothing names the model", () => {
    const { ctx, logger } = makeCtx()
    seedSession(ctx)
    handleStepEnded(ended(), ctx)
    expect(logger.records.at(-1)!.attributes?.["model"]).toBe("unknown")
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

  test("folds reasoning into output for failed steps when combineReasoningTokens is enabled", () => {
    const { ctx, tracer, counters } = makeCtx("proj_test", [], [], true, {}, true)
    seedSession(ctx)
    handleStepStarted(stepStarted(), ctx)
    handleStepFailed(
      evt("session.step.failed", { sessionID: "ses_1", assistantMessageID: "msg_1", error: { type: "x", message: "y" }, tokens: tokens(10, 5, 2) }),
      ctx,
    )
    expect(counters.token.calls.some((c) => c.attrs["type"] === "reasoning")).toBe(false)
    expect(counters.token.calls.find((c) => c.attrs["type"] === "output")!.value).toBe(7)
    expect(tracer.spans.find((s) => s.name === "opencode.llm")!.attributes["llm.token_count.completion"]).toBe(7)
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
