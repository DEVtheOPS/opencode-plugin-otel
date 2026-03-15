import { describe, test, expect } from "bun:test"
import { errorSummary, setBoundedMap, isMetricEnabled } from "../src/util.ts"
import { MAX_PENDING } from "../src/types.ts"

describe("errorSummary", () => {
  test("returns 'unknown' for undefined", () => {
    expect(errorSummary(undefined)).toBe("unknown")
  })

  test("returns name when no data", () => {
    expect(errorSummary({ name: "APIError" })).toBe("APIError")
  })

  test("returns name when data has no message", () => {
    expect(errorSummary({ name: "APIError", data: { code: 500 } })).toBe("APIError")
  })

  test("returns name: message when data has message", () => {
    expect(errorSummary({ name: "APIError", data: { message: "rate limited" } })).toBe(
      "APIError: rate limited",
    )
  })

  test("returns name when data is a primitive", () => {
    expect(errorSummary({ name: "APIError", data: "oops" })).toBe("APIError")
  })
})

describe("setBoundedMap", () => {
  test("adds an entry to the map", () => {
    const map = new Map<string, number>()
    setBoundedMap(map, "a", 1)
    expect(map.get("a")).toBe(1)
  })

  test("evicts the oldest entry when at capacity", () => {
    const map = new Map<string, number>()
    for (let i = 0; i < MAX_PENDING; i++) {
      setBoundedMap(map, `key-${i}`, i)
    }
    expect(map.size).toBe(MAX_PENDING)
    expect(map.has("key-0")).toBe(true)

    setBoundedMap(map, "overflow", 999)
    expect(map.size).toBe(MAX_PENDING)
    expect(map.has("key-0")).toBe(false)
    expect(map.has("overflow")).toBe(true)
  })

  test("does not evict when below capacity", () => {
    const map = new Map<string, number>()
    setBoundedMap(map, "a", 1)
    setBoundedMap(map, "b", 2)
    expect(map.size).toBe(2)
    expect(map.has("a")).toBe(true)
  })

  test("overwrites an existing key without evicting", () => {
    const map = new Map<string, number>()
    setBoundedMap(map, "a", 1)
    setBoundedMap(map, "a", 2)
    expect(map.get("a")).toBe(2)
    expect(map.size).toBe(1)
  })
})

describe("isMetricEnabled", () => {
  test("returns true when disabled set is empty", () => {
    expect(isMetricEnabled("session.count", { disabledMetrics: new Set() })).toBe(true)
  })

  test("returns false when metric is in the disabled set", () => {
    expect(isMetricEnabled("session.count", { disabledMetrics: new Set(["session.count"]) })).toBe(false)
  })

  test("returns true when a different metric is disabled", () => {
    expect(isMetricEnabled("session.count", { disabledMetrics: new Set(["cache.count"]) })).toBe(true)
  })

  test("is case-sensitive — does not match mismatched case", () => {
    expect(isMetricEnabled("session.count", { disabledMetrics: new Set(["Session.Count"]) })).toBe(true)
  })

  test("unknown metric names in disabled set do not affect known metrics", () => {
    expect(isMetricEnabled("retry.count", { disabledMetrics: new Set(["does.not.exist"]) })).toBe(true)
  })
})
