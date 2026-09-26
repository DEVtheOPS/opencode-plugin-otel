import { describe, test, expect } from "bun:test"
import { loadConfig } from "../src/config.ts"
import { acquireSharedOtel, configKey } from "../src/state.ts"
import { makeCtx } from "./helpers.ts"
import { contextForSession, markSeen } from "../src/util.ts"
import type { HandlerContext } from "../src/types.ts"

describe("multi-location telemetry", () => {
  test("rejects a second location with different exporter settings", async () => {
    const first = loadConfig({ enabled: true, endpoint: "http://one:4317", otlpHeaders: "Authorization=secret-a" })
    const second = loadConfig({ enabled: true, endpoint: "http://two:4317", otlpHeaders: "Authorization=secret-b" })
    const key = "__opencode_plugin_otel_shared__"
    const globals = globalThis as Record<string, unknown>
    const previous = globals[key]
    const fake = { configKey: configKey(first), refs: 1 }
    globals[key] = fake
    try {
      await expect(acquireSharedOtel(second, "2.0.0")).rejects.toThrow("identical telemetry configuration")
      expect(fake.refs).toBe(1)
      expect(await acquireSharedOtel(first, "2.0.0")).toBe(fake as never)
      expect(fake.refs).toBe(2)
    } finally {
      globals[key] = previous
    }
  })

  test("attributes observed sessions to their own projects", async () => {
    const { ctx } = makeCtx()
    const base: HandlerContext = { ...ctx, commonAttrs: { team: "platform" } }
    const projectFor = async (id: string) => id === "one" ? "project-one" : "project-two"
    const first = await contextForSession("one", base, projectFor)
    const second = await contextForSession("two", base, projectFor)
    expect(first.commonAttrs["project.id"]).toBe("project-one")
    expect(second.commonAttrs["project.id"]).toBe("project-two")
    expect(base.commonAttrs["project.id"]).toBeUndefined()
    expect((await contextForSession("unknown", base, async () => { throw new Error("not found") })).commonAttrs["project.id"]).toBeUndefined()
  })

  test("bounds session and message deduplication sets", () => {
    const { ctx } = makeCtx()
    for (let i = 0; i < 10_050; i++) {
      markSeen(ctx.tracing.countedSessions, `s${i}`)
      markSeen(ctx.tracing.countedMessages, `m${i}`)
    }
    expect(ctx.tracing.countedSessions.size).toBe(10_000)
    expect(ctx.tracing.countedMessages.size).toBe(10_000)
  })
})
