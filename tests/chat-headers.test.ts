import { describe, test, expect } from "bun:test"
import { handleChatHeaders, getResolvedURL, matchesEndpoint } from "../src/handlers/chat-headers.ts"
import { makeCtx } from "./helpers.ts"

describe("getResolvedURL", () => {
  test("returns provider.options.baseURL when set", () => {
    const provider = { options: { baseURL: "https://litellm.example.com" } } as any
    const model = { api: { url: "https://api.openai.com" } } as any
    expect(getResolvedURL(provider, model)).toBe("https://litellm.example.com")
  })

  test("falls back to model.api.url when baseURL unset", () => {
    expect(getResolvedURL({ options: {} } as any, { api: { url: "https://api.openai.com" } } as any))
      .toBe("https://api.openai.com")
  })

  test("falls back to model.api.url when baseURL is an empty string", () => {
    expect(getResolvedURL({ options: { baseURL: "" } } as any, { api: { url: "https://api.openai.com" } } as any))
      .toBe("https://api.openai.com")
  })

  test("returns empty string when both unset", () => {
    expect(getResolvedURL({ options: {} } as any, {} as any)).toBe("")
  })
})

describe("matchesEndpoint", () => {
  test("matches everything when the allowlist is empty", () => {
    expect(matchesEndpoint("https://api.openai.com", [])).toBe(true)
  })

  test("matches by hostname, ignoring path", () => {
    expect(matchesEndpoint("https://litellm.example.com/v1/chat", ["https://litellm.example.com"])).toBe(true)
  })

  test("rejects a non-matching hostname", () => {
    expect(matchesEndpoint("https://api.openai.com/v1/chat", ["https://litellm.example.com"])).toBe(false)
  })

  test("fails closed on an unparseable resolved URL", () => {
    expect(matchesEndpoint("not-a-url", ["https://litellm.example.com"])).toBe(false)
  })

  test("ignores unparseable allowlist entries", () => {
    expect(matchesEndpoint("https://litellm.example.com", ["", "https://litellm.example.com"])).toBe(true)
  })
})

describe("handleChatHeaders", () => {
  const makeInput = (providerOpts: Record<string, any> = {}, api: any = { url: "https://api.openai.com" }) => ({
    sessionID: "sess-1",
    agent: "test",
    model: { api } as any,
    provider: { options: providerOpts } as any,
    message: { id: "msg-1" } as any,
  })
  const makeOutput = () => ({ headers: {} as Record<string, string> })

  test("injects headers when no endpoint filter is configured", () => {
    const { ctx } = makeCtx()
    ctx.outboundHeaders = { "x-test": "value" }
    const output = makeOutput()
    handleChatHeaders(makeInput(), output, ctx)
    expect(output.headers["x-test"]).toBe("value")
  })

  test("injects headers when the endpoint matches", () => {
    const { ctx } = makeCtx()
    ctx.outboundHeaders = { "x-test": "value" }
    ctx.outboundEndpoints = ["https://litellm.example.com"]
    const output = makeOutput()
    handleChatHeaders(makeInput({ baseURL: "https://litellm.example.com" }), output, ctx)
    expect(output.headers["x-test"]).toBe("value")
  })

  test("skips headers when the endpoint does not match", () => {
    const { ctx } = makeCtx()
    ctx.outboundHeaders = { "x-test": "value" }
    ctx.outboundEndpoints = ["https://litellm.example.com"]
    const output = makeOutput()
    handleChatHeaders(makeInput(), output, ctx) // defaults to api.openai.com
    expect(output.headers["x-test"]).toBeUndefined()
  })

  test("injects multiple headers", () => {
    const { ctx } = makeCtx()
    ctx.outboundHeaders = { "x-a": "1", "x-b": "2" }
    const output = makeOutput()
    handleChatHeaders(makeInput(), output, ctx)
    expect(output.headers).toEqual({ "x-a": "1", "x-b": "2" })
  })

  test("is a no-op when no headers are configured", () => {
    const { ctx } = makeCtx()
    const output = makeOutput()
    handleChatHeaders(makeInput(), output, ctx)
    expect(Object.keys(output.headers).length).toBe(0)
  })
})
