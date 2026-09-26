import { describe, test, expect } from "bun:test"
import { handleModelRequest } from "../src/handlers/chat-headers.ts"
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
