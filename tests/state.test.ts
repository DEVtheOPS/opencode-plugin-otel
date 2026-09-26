import { describe, test, expect } from "bun:test"
import { loadConfig } from "../src/config.ts"
import { acquireSharedOtel, configKey, createFlushScheduler } from "../src/state.ts"
import { makeCtx } from "./helpers.ts"
import { consumeEvents, contextForSession, enqueueEvent, markSeen } from "../src/util.ts"
import type { HandlerContext } from "../src/types.ts"
import { handleExecutionStarted } from "../src/handlers/session.ts"
import { handleModelRequest } from "../src/handlers/chat-headers.ts"
import { evt } from "./helpers.ts"

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
    const projectFor = async (id: string) => ({ projectID: id === "one" ? "project-one" : "project-two", time: { created: 100 } })
    const first = await contextForSession("one", base, projectFor)
    const second = await contextForSession("two", base, projectFor)
    expect(first.commonAttrs["project.id"]).toBe("project-one")
    expect(second.commonAttrs["project.id"]).toBe("project-two")
    expect(base.commonAttrs["project.id"]).toBeUndefined()
    expect((await contextForSession("unknown", base, async () => { throw new Error("not found") })).commonAttrs["project.id"]).toBeUndefined()
  })

  test("hydrates a resumed subagent when session.created was missed", async () => {
    const { ctx } = makeCtx()
    const scoped = await contextForSession("sub", ctx, async () => ({
      projectID: "other-project",
      agent: "explore",
      parentID: "parent",
      time: { created: 500 },
    }))
    handleExecutionStarted(evt("session.execution.started", { sessionID: "sub" }, 1000), scoped)
    expect(ctx.tracing.sessionTotals.get("sub")).toMatchObject({
      agent: "explore", agentType: "subagent", parentID: "parent", startMs: 500,
    })
    expect(scoped.commonAttrs["project.id"]).toBe("other-project")
  })

  test("serializes duplicate subscribers across an asynchronous lookup", async () => {
    const { ctx } = makeCtx()
    const order: string[] = []
    let release!: () => void
    const lookup = new Promise<void>((resolve) => { release = resolve })
    const started = enqueueEvent(ctx.tracing, "start", async () => {
      await lookup
      order.push("start")
    })
    const duplicate = enqueueEvent(ctx.tracing, "start", async () => { order.push("duplicate") })
    const ended = enqueueEvent(ctx.tracing, "end", async () => { order.push("end") })
    release()
    await Promise.all([started, duplicate, ended])
    expect(order).toEqual(["start", "end"])
  })

  test("drains buffered step events before a concurrent model request uses their context", async () => {
    const { ctx } = makeCtx()
    ctx.tracePropagationProviders.add("*")
    ctx.tracing.activeLlm.set("s", {
      agent: "build", modelID: "m", providerID: "vllm",
      spanContext: { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", traceFlags: 1 },
    })
    let release!: () => void
    let queued!: () => void
    const lookup = new Promise<void>((resolve) => { release = resolve })
    const bothQueued = new Promise<void>((resolve) => { queued = resolve })
    async function* events() {
      yield { id: "step.started" }
      yield { id: "step.ended" }
      queued()
    }
    const processing = consumeEvents(events(), ctx.tracing, async (event) => {
      if (event.id === "step.started") await lookup
      else ctx.tracing.activeLlm.delete("s")
    }, async () => {})
    await bothQueued
    const headers: Record<string, string> = {}
    const request = handleModelRequest({ sessionID: "s", agent: "build", model: { providerID: "vllm", id: "m" }, kind: "primary", headers }, ctx)
    expect(headers["traceparent"]).toBeUndefined()
    release()
    await Promise.all([processing, request])
    expect(headers["traceparent"]).toBeDefined()
    expect(headers["traceparent"]).not.toContain("b7ad6b7169203331")
  })

  test("does not block the shared event queue on a pending exporter flush", async () => {
    const { ctx } = makeCtx()
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    const flush = createFlushScheduler(() => wait)
    await enqueueEvent(ctx.tracing, "end", async () => { flush.request() })
    let started = false
    await enqueueEvent(ctx.tracing, "next", async () => { started = true })
    expect(started).toBe(true)
    release()
    await flush.drain()
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
