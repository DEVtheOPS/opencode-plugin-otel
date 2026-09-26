import { describe, test, expect } from "bun:test"
import { captureModelContext, handleModelRequest } from "../src/handlers/chat-headers.ts"
import { handleStepStarted } from "../src/handlers/step.ts"
import { makeCtx, evt } from "./helpers.ts"

const SPAN_CONTEXT = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: 1,
}

describe("handleModelRequest", () => {
  test("injects traceparent for a configured provider", async () => {
    const { ctx } = makeCtx()
    ctx.tracePropagationProviders.add("litellm")
    ctx.tracing.activeLlm.set("ses_1", { agent: "build", modelID: "m", providerID: "litellm", spanContext: SPAN_CONTEXT })
    const headers: Record<string, string> = {}
    await handleModelRequest({ sessionID: "ses_1", agent: "build", model: { providerID: "litellm", id: "m" }, kind: "primary", headers }, ctx)
    expect(headers["traceparent"]).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
  })

  test("does nothing when the provider is not configured", async () => {
    const { ctx } = makeCtx()
    ctx.tracing.activeLlm.set("ses_1", { agent: "build", modelID: "m", providerID: "openai", spanContext: SPAN_CONTEXT })
    const headers: Record<string, string> = {}
    await handleModelRequest({ sessionID: "ses_1", agent: "build", model: { providerID: "openai", id: "m" }, kind: "primary", headers }, ctx)
    expect(headers["traceparent"]).toBeUndefined()
  })

  test("supports the wildcard provider", async () => {
    const { ctx } = makeCtx()
    ctx.tracePropagationProviders.add("*")
    ctx.tracing.activeLlm.set("ses_1", { agent: "build", modelID: "m", providerID: "vllm", spanContext: SPAN_CONTEXT })
    const headers: Record<string, string> = {}
    await handleModelRequest({ sessionID: "ses_1", agent: "build", model: { providerID: "vllm", id: "m" }, kind: "primary", headers }, ctx)
    expect(headers["traceparent"]).toBeDefined()
  })

  test("does not propagate a primary step into an auxiliary model request", async () => {
    const { ctx } = makeCtx()
    ctx.tracePropagationProviders.add("*")
    ctx.tracing.activeLlm.set("ses_1", { agent: "build", modelID: "m", providerID: "vllm", spanContext: SPAN_CONTEXT })
    const headers: Record<string, string> = {}
    await handleModelRequest({ sessionID: "ses_1", agent: "build", model: { providerID: "vllm", id: "m" }, kind: "title", headers }, ctx)
    expect(headers["traceparent"]).toBeUndefined()
  })

  test("injects the matching context into a WebSocket handshake", async () => {
    const { ctx } = makeCtx()
    ctx.tracePropagationProviders.add("openai")
    ctx.tracing.activeLlm.set("ses_1", { agent: "build", modelID: "m", providerID: "openai", spanContext: SPAN_CONTEXT })
    const handshake = { sessionID: "ses_1", agent: "build", model: { providerID: "openai", id: "m" }, kind: "primary", url: "wss://example.invalid/v1", headers: {} as Record<string, string> }
    await handleModelRequest(handshake, ctx)
    expect(handshake.headers["traceparent"]).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
  })

  test("waits for pending event processing and adopts a provisional span", async () => {
    const { ctx, tracer } = makeCtx()
    ctx.tracePropagationProviders.add("*")
    let release!: () => void
    ctx.tracing.eventQueue = new Promise<void>((resolve) => { release = resolve })
    const headers: Record<string, string> = {}
    const request = handleModelRequest({ sessionID: "ses_1", agent: "build", model: { providerID: "vllm", id: "m" }, kind: "primary", headers }, ctx)
    expect(headers["traceparent"]).toBeUndefined()
    release()
    await request
    expect(headers["traceparent"]).toBeDefined()
    handleStepStarted(evt("session.step.started", { sessionID: "ses_1", assistantMessageID: "msg_1", agent: "build", model: { id: "m", providerID: "vllm" }, started: 100 }), ctx)
    expect(tracer.spans.filter((span) => span.name === "opencode.llm")).toHaveLength(1)
    expect(ctx.tracing.stepSpans.get("msg_1")?.spanContext().spanId).toBe(ctx.tracing.activeLlm.get("ses_1")?.spanContext.spanId)
  })
})

describe("captureModelContext", () => {
  test("captures a bounded text-only preview and attaches it to the matching LLM span", async () => {
    const { ctx, tracer } = makeCtx()
    captureModelContext({
      sessionID: "ses_1", agent: "build", model: { providerID: "vllm", id: "m" },
      system: [{ type: "text", text: "policy" }],
      messages: [
        { role: "user", content: [{ type: "media", media: { source: { type: "base64", data: "SECRET_BINARY" } } }, { type: "text", text: "x".repeat(10_000) }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ],
    }, ctx)
    await handleModelRequest({ sessionID: "ses_1", agent: "build", model: { providerID: "vllm", id: "m" }, kind: "primary", headers: {} }, ctx)
    const span = tracer.spans.find((candidate) => candidate.name === "opencode.llm")!
    expect(span.attributes["input.value"]).toBe("x".repeat(1_000))
    expect(String(span.attributes["llm.input_messages"])).toContain('"role":"system"')
    expect(String(span.attributes["llm.input_messages"])).not.toContain("SECRET_BINARY")
    expect(String(span.attributes["llm.input_messages"]).length).toBeLessThan(16_000)
    expect(ctx.tracing.modelContexts.size).toBe(1)
    ctx.tracing.activePrompts.set("ses_1", { text: "admitted prompt", startMs: 1 })
    handleStepStarted(evt("session.step.started", { sessionID: "ses_1", assistantMessageID: "msg_1", agent: "build", model: { id: "m", providerID: "vllm" }, started: 1 }), ctx)
    expect(span.attributes["input.value"]).toBe("x".repeat(1_000))
    expect(ctx.tracing.modelContexts.size).toBe(0)
  })

  test("does not attach a snapshot from a different model", async () => {
    const { ctx, tracer } = makeCtx()
    captureModelContext({ sessionID: "ses_1", agent: "build", model: { providerID: "vllm", id: "other" }, system: [], messages: [] }, ctx)
    ctx.tracePropagationProviders.add("*")
    await handleModelRequest({ sessionID: "ses_1", agent: "build", model: { providerID: "vllm", id: "m" }, kind: "primary", headers: {} }, ctx)
    expect(tracer.spans[0]?.attributes["llm.input_messages"]).toBeUndefined()
  })
})
