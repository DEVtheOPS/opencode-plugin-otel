import { describe, test, expect } from "bun:test"
import { probeEndpoint, parseEndpoint } from "../src/probe.ts"

describe("parseEndpoint", () => {
  test("uses port 80 for http:// URLs without explicit port", () => {
    expect(parseEndpoint("http://api.honeycomb.io")).toEqual({ host: "api.honeycomb.io", port: 80 })
  })

  test("uses port 443 for https:// URLs without explicit port", () => {
    expect(parseEndpoint("https://api.honeycomb.io")).toEqual({ host: "api.honeycomb.io", port: 443 })
  })

  test("uses explicit port when provided", () => {
    expect(parseEndpoint("http://localhost:4317")).toEqual({ host: "localhost", port: 4317 })
  })

  test("defaults to 4317 for unknown protocols without explicit port", () => {
    expect(parseEndpoint("grpc://api.honeycomb.io")).toEqual({ host: "api.honeycomb.io", port: 4317 })
  })

  test("returns null for invalid URLs", () => {
    expect(parseEndpoint("not a url")).toBeNull()
  })
})

describe("probeEndpoint", () => {
  test("returns error for malformed URL (no scheme)", async () => {
    const result = await probeEndpoint("localhost:4317")
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  test("returns error for completely invalid URL", async () => {
    const result = await probeEndpoint("not a url at all")
    expect(result.ok).toBe(false)
    expect(result.error).toContain("invalid endpoint URL")
  })

  test("returns error when nothing is listening on the port", async () => {
    const result = await probeEndpoint("http://127.0.0.1:19999")
    expect(result.ok).toBe(false)
    expect(result.ms).toBeGreaterThanOrEqual(0)
    expect(result.error).toBeDefined()
  })

  test("returns ok when port is open", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    const port = server.port
    try {
      const result = await probeEndpoint(`http://127.0.0.1:${port}`)
      expect(result.ok).toBe(true)
      expect(result.ms).toBeGreaterThanOrEqual(0)
      expect(result.error).toBeUndefined()
    } finally {
      server.stop()
    }
  })
})
