import { describe, test, expect } from "bun:test"
import { handleModelRequest } from "../src/handlers/chat-headers.ts"
import { makeCtx } from "./helpers.ts"

const SPAN_CONTEXT = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: 1,
}

describe("handleModelRequest", () => {
  test("injects traceparent for a configured provider", () => {
    const { ctx } = makeCtx()
    ctx.tracePropagationProviders.add("litellm")
    ctx.tracing.activeLlm.set("ses_1", { agent: "build", modelID: "m", providerID: "litellm", spanContext: SPAN_CONTEXT })
    const headers: Record<string, string> = {}
    handleModelRequest({ sessionID: "ses_1", agent: "build", model: { providerID: "litellm", id: "m" }, kind: "primary", headers }, ctx)
    expect(headers["traceparent"]).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
  })

  test("does nothing when the provider is not configured", () => {
    const { ctx } = makeCtx()
    ctx.tracing.activeLlm.set("ses_1", { agent: "build", modelID: "m", providerID: "openai", spanContext: SPAN_CONTEXT })
    const headers: Record<string, string> = {}
    handleModelRequest({ sessionID: "ses_1", agent: "build", model: { providerID: "openai", id: "m" }, kind: "primary", headers }, ctx)
    expect(headers["traceparent"]).toBeUndefined()
  })

  test("supports the wildcard provider", () => {
    const { ctx } = makeCtx()
    ctx.tracePropagationProviders.add("*")
    ctx.tracing.activeLlm.set("ses_1", { agent: "build", modelID: "m", providerID: "vllm", spanContext: SPAN_CONTEXT })
    const headers: Record<string, string> = {}
    handleModelRequest({ sessionID: "ses_1", agent: "build", model: { providerID: "vllm", id: "m" }, kind: "primary", headers }, ctx)
    expect(headers["traceparent"]).toBeDefined()
  })
})
