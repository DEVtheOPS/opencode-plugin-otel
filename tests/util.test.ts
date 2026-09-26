import { describe, test, expect } from "bun:test"
import { MAX_PENDING } from "../src/types.ts"
import { errorSummary, genAiProviderName, markSeen, modelRef, setBoundedMap, totalTokens } from "../src/util.ts"

describe("errorSummary", () => {
  test("formats structured errors", () => {
    expect(errorSummary({ type: "ProviderError", message: "boom" })).toBe("ProviderError: boom")
    expect(errorSummary(undefined)).toBe("unknown")
  })
})

describe("genAiProviderName", () => {
  test("maps known providers and preserves unknown ones", () => {
    expect(genAiProviderName("amazon-bedrock")).toBe("aws.bedrock")
    expect(genAiProviderName("custom")).toBe("custom")
  })
})

describe("totalTokens", () => {
  test("sums input, output, and reasoning only", () => {
    expect(totalTokens({ input: 1, output: 2, reasoning: 3, cache: { read: 10, write: 10 } })).toBe(6)
    expect(totalTokens(undefined)).toBe(0)
  })
})

describe("modelRef", () => {
  test("formats provider/id", () => {
    expect(modelRef({ providerID: "anthropic", id: "claude" })).toBe("anthropic/claude")
    expect(modelRef(undefined)).toBe("unknown")
  })
})

describe("setBoundedMap", () => {
  test("evicts the oldest entry at capacity", () => {
    const map = new Map<number, number>()
    for (let i = 0; i < MAX_PENDING; i++) setBoundedMap(map, i, i)
    expect(map.size).toBe(MAX_PENDING)
    setBoundedMap(map, MAX_PENDING, MAX_PENDING)
    expect(map.size).toBe(MAX_PENDING)
    expect(map.has(0)).toBe(false)
  })
})

describe("markSeen", () => {
  test("records unique event ids", () => {
    const seen = new Set<string>()
    markSeen(seen, "a")
    markSeen(seen, "b")
    expect(seen.has("a")).toBe(true)
    expect(seen.size).toBe(2)
  })
})
