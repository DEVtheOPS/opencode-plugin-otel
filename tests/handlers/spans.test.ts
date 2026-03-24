import { describe, test, expect } from "bun:test"
import { SpanStatusCode } from "@opentelemetry/api"
import type { Span } from "@opentelemetry/api"
import { handleSessionCreated, handleSessionIdle, handleSessionError } from "../../src/handlers/session.ts"
import { handleMessageUpdated, handleMessagePartUpdated, startMessageSpan } from "../../src/handlers/message.ts"
import { makeCtx, makeTracer, type SpySpan } from "../helpers.ts"
import type {
  EventSessionCreated,
  EventSessionIdle,
  EventSessionError,
  EventMessageUpdated,
  EventMessagePartUpdated,
} from "@opencode-ai/sdk"

function makeSessionCreated(sessionID: string, createdAt = 1000, parentID?: string): EventSessionCreated {
  return {
    type: "session.created",
    properties: { info: { id: sessionID, projectID: "proj_test", directory: "/tmp", parentID, time: { created: createdAt } } },
  } as unknown as EventSessionCreated
}

function makeSessionIdle(sessionID: string): EventSessionIdle {
  return { type: "session.idle", properties: { sessionID } } as EventSessionIdle
}

function makeSessionError(sessionID: string, error?: { name: string }): EventSessionError {
  return { type: "session.error", properties: { sessionID, error } } as unknown as EventSessionError
}

function makeAssistantMessageUpdated(overrides: {
  id?: string
  sessionID?: string
  modelID?: string
  providerID?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  time?: { created: number; completed?: number }
  error?: { name: string }
}): EventMessageUpdated {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: overrides.id ?? "msg_1",
        role: "assistant",
        sessionID: overrides.sessionID ?? "ses_1",
        modelID: overrides.modelID ?? "claude-3-5-sonnet",
        providerID: overrides.providerID ?? "anthropic",
        cost: overrides.cost ?? 0.01,
        tokens: overrides.tokens ?? { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        time: overrides.time ?? { created: 1000, completed: 2000 },
        error: overrides.error,
      },
    },
  } as unknown as EventMessageUpdated
}

function makeToolPartUpdated(
  status: "running" | "completed" | "error",
  overrides: { sessionID?: string; callID?: string; tool?: string; startMs?: number; endMs?: number } = {},
): EventMessagePartUpdated {
  const sessionID = overrides.sessionID ?? "ses_1"
  const callID = overrides.callID ?? "call_1"
  const start = overrides.startMs ?? 1000
  const end = overrides.endMs ?? 2000
  const state =
    status === "running"
      ? { status: "running", time: { start } }
      : status === "completed"
        ? { status: "completed", time: { start, end }, output: "ok" }
        : { status: "error", time: { start, end }, error: "fail" }
  return {
    type: "message.part.updated",
    properties: { part: { type: "tool", sessionID, callID, tool: overrides.tool ?? "bash", state } },
  } as unknown as EventMessagePartUpdated
}

describe("session spans", () => {
  test("starts a session span on session.created", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_1", 5000), ctx)
    expect(tracer.spans).toHaveLength(1)
    expect(tracer.spans[0]!.name).toBe("opencode.session")
    expect(tracer.spans[0]!.startTime).toBe(5000)
    expect(ctx.sessionSpans.has("ses_1")).toBe(true)
  })

  test("session span carries session.id attribute", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(tracer.spans[0]!.attributes["session.id"]).toBe("ses_1")
  })

  test("session span carries is_subagent=false for root session", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_root"), ctx)
    expect(tracer.spans[0]!.attributes["session.is_subagent"]).toBe(false)
  })

  test("session span carries is_subagent=true for subagent session", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_child", 1000, "ses_parent"), ctx)
    expect(tracer.spans[0]!.attributes["session.is_subagent"]).toBe(true)
  })

  test("ends session span with OK status on session.idle", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    const span = tracer.spans[0]!
    expect(span.ended).toBe(true)
    expect(span.status.code).toBe(SpanStatusCode.OK)
    expect(ctx.sessionSpans.has("ses_1")).toBe(false)
  })

  test("sets session total attributes before ending on idle", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    ctx.sessionTotals.set("ses_1", { startMs: Date.now() - 100, tokens: 250, cost: 0.05, messages: 3, agent: "build" })
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    const span = tracer.spans[0]!
    expect(span.attributes["session.total_tokens"]).toBe(250)
    expect(span.attributes["session.total_cost_usd"]).toBe(0.05)
    expect(span.attributes["session.total_messages"]).toBe(3)
  })

  test("ends session span with ERROR status on session.error", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleSessionError(makeSessionError("ses_1", { name: "NetworkError" }), ctx)
    const span = tracer.spans[0]!
    expect(span.ended).toBe(true)
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(ctx.sessionSpans.has("ses_1")).toBe(false)
  })

  test("error message is propagated to session span status", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleSessionError(makeSessionError("ses_1", { name: "TimeoutError" }), ctx)
    expect(tracer.spans[0]!.status.message).toBe("TimeoutError")
  })

  test("idle on unknown session does not throw and creates no span", () => {
    const { ctx, tracer } = makeCtx()
    expect(() => handleSessionIdle(makeSessionIdle("ses_unknown"), ctx)).not.toThrow()
    expect(tracer.spans).toHaveLength(0)
  })

  test("subagent span — parent session span is in sessionSpans before child is created", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_parent"), ctx)
    handleSessionCreated(makeSessionCreated("ses_child", 2000, "ses_parent"), ctx)
    expect(tracer.spans).toHaveLength(2)
    expect(tracer.spans[1]!.name).toBe("opencode.session")
  })

  test("subagent span — no error when parent session span is absent", () => {
    const { ctx, tracer } = makeCtx()
    expect(() => handleSessionCreated(makeSessionCreated("ses_child", 1000, "ses_missing_parent"), ctx)).not.toThrow()
    expect(tracer.spans).toHaveLength(1)
  })
})

describe("tool spans", () => {
  test("starts a tool span on running status", () => {
    const { ctx, tracer } = makeCtx()
    handleMessagePartUpdated(makeToolPartUpdated("running", { startMs: 1000 }), ctx)
    expect(tracer.spans).toHaveLength(1)
    expect(tracer.spans[0]!.name).toBe("opencode.tool bash")
    expect(tracer.spans[0]!.startTime).toBe(1000)
    expect(ctx.pendingToolSpans.has("ses_1:call_1")).toBe(true)
  })

  test("tool span carries tool.name attribute", () => {
    const { ctx, tracer } = makeCtx()
    handleMessagePartUpdated(makeToolPartUpdated("running", { tool: "read_file" }), ctx)
    expect(tracer.spans[0]!.attributes["tool.name"]).toBe("read_file")
  })

  test("ends tool span with OK status on completion", () => {
    const { ctx, tracer } = makeCtx()
    handleMessagePartUpdated(makeToolPartUpdated("running"), ctx)
    handleMessagePartUpdated(makeToolPartUpdated("completed", { endMs: 2000 }), ctx)
    const span = tracer.spans[0]!
    expect(span.ended).toBe(true)
    expect(span.status.code).toBe(SpanStatusCode.OK)
    expect(span.endTime).toBe(2000)
  })

  test("ends tool span with ERROR status on error", () => {
    const { ctx, tracer } = makeCtx()
    handleMessagePartUpdated(makeToolPartUpdated("running"), ctx)
    handleMessagePartUpdated(makeToolPartUpdated("error"), ctx)
    const span = tracer.spans[0]!
    expect(span.ended).toBe(true)
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
  })

  test("tool span result_size_bytes set on success", () => {
    const { ctx, tracer } = makeCtx()
    handleMessagePartUpdated(makeToolPartUpdated("running"), ctx)
    handleMessagePartUpdated(makeToolPartUpdated("completed"), ctx)
    expect(typeof tracer.spans[0]!.attributes["tool.result_size_bytes"]).toBe("number")
  })

  test("tool span error attr set on error status", () => {
    const { ctx, tracer } = makeCtx()
    handleMessagePartUpdated(makeToolPartUpdated("running"), ctx)
    handleMessagePartUpdated(makeToolPartUpdated("error"), ctx)
    expect(tracer.spans[0]!.attributes["tool.error"]).toBe("fail")
  })

  test("tool span removed from pendingToolSpans after completion", () => {
    const { ctx } = makeCtx()
    handleMessagePartUpdated(makeToolPartUpdated("running"), ctx)
    handleMessagePartUpdated(makeToolPartUpdated("completed"), ctx)
    expect(ctx.pendingToolSpans.size).toBe(0)
  })

  test("tool span started even when completed arrives without prior running (out-of-order)", () => {
    const { ctx, tracer } = makeCtx()
    handleMessagePartUpdated(makeToolPartUpdated("completed", { startMs: 500, endMs: 1500 }), ctx)
    expect(tracer.spans).toHaveLength(1)
    expect(tracer.spans[0]!.ended).toBe(true)
    expect(tracer.spans[0]!.status.code).toBe(SpanStatusCode.OK)
  })

  test("tool span is parented to session span when available", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleMessagePartUpdated(makeToolPartUpdated("running", { sessionID: "ses_1" }), ctx)
    expect(tracer.spans).toHaveLength(2)
    expect(tracer.spans[1]!.name).toBe("opencode.tool bash")
  })
})

describe("message (LLM) spans", () => {
  test("startMessageSpan creates a gen_ai.chat span", () => {
    const { ctx, tracer } = makeCtx()
    startMessageSpan("ses_1", "msg_1", "claude-3-5-sonnet", "anthropic", 1000, ctx)
    expect(tracer.spans).toHaveLength(1)
    expect(tracer.spans[0]!.name).toBe("gen_ai.chat")
    expect(ctx.messageSpans.has("msg_1")).toBe(true)
  })

  test("startMessageSpan sets gen_ai.* attributes", () => {
    const { ctx, tracer } = makeCtx()
    startMessageSpan("ses_1", "msg_1", "gpt-4o", "openai", 1000, ctx)
    expect(tracer.spans[0]!.attributes["gen_ai.system"]).toBe("openai")
    expect(tracer.spans[0]!.attributes["gen_ai.request.model"]).toBe("gpt-4o")
  })

  test("startMessageSpan is a no-op when span already exists for messageID", () => {
    const { ctx, tracer } = makeCtx()
    startMessageSpan("ses_1", "msg_1", "claude", "anthropic", 1000, ctx)
    startMessageSpan("ses_1", "msg_1", "claude", "anthropic", 1000, ctx)
    expect(tracer.spans).toHaveLength(1)
  })

  test("handleMessageUpdated ends message span on completion", () => {
    const { ctx, tracer } = makeCtx()
    startMessageSpan("ses_1", "msg_1", "claude-3-5-sonnet", "anthropic", 1000, ctx)
    handleMessageUpdated(makeAssistantMessageUpdated({ id: "msg_1", time: { created: 1000, completed: 2000 } }), ctx)
    const span = tracer.spans[0]!
    expect(span.ended).toBe(true)
    expect(span.endTime).toBe(2000)
    expect(ctx.messageSpans.has("msg_1")).toBe(false)
  })

  test("handleMessageUpdated sets OK status on success", () => {
    const { ctx, tracer } = makeCtx()
    startMessageSpan("ses_1", "msg_1", "claude-3-5-sonnet", "anthropic", 1000, ctx)
    handleMessageUpdated(makeAssistantMessageUpdated({ id: "msg_1" }), ctx)
    expect(tracer.spans[0]!.status.code).toBe(SpanStatusCode.OK)
  })

  test("handleMessageUpdated sets ERROR status on api error", () => {
    const { ctx, tracer } = makeCtx()
    startMessageSpan("ses_1", "msg_1", "claude-3-5-sonnet", "anthropic", 1000, ctx)
    handleMessageUpdated(makeAssistantMessageUpdated({ id: "msg_1", error: { name: "RateLimitError" } }), ctx)
    expect(tracer.spans[0]!.status.code).toBe(SpanStatusCode.ERROR)
    expect(tracer.spans[0]!.status.message).toBe("RateLimitError")
  })

  test("handleMessageUpdated sets gen_ai.usage token attributes on span", () => {
    const { ctx, tracer } = makeCtx()
    startMessageSpan("ses_1", "msg_1", "claude-3-5-sonnet", "anthropic", 1000, ctx)
    handleMessageUpdated(
      makeAssistantMessageUpdated({
        id: "msg_1",
        tokens: { input: 200, output: 80, reasoning: 10, cache: { read: 30, write: 5 } },
      }),
      ctx,
    )
    const span = tracer.spans[0]!
    expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(200)
    expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(80)
    expect(span.attributes["gen_ai.usage.reasoning_tokens"]).toBe(10)
    expect(span.attributes["gen_ai.usage.cache_read_tokens"]).toBe(30)
    expect(span.attributes["gen_ai.usage.cache_creation_tokens"]).toBe(5)
  })

  test("handleMessageUpdated no-ops span handling when no span exists for messageID", () => {
    const { ctx } = makeCtx()
    expect(() =>
      handleMessageUpdated(makeAssistantMessageUpdated({ id: "msg_no_span" }), ctx)
    ).not.toThrow()
  })

  test("message span is parented to session span when available", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    startMessageSpan("ses_1", "msg_1", "claude", "anthropic", 1000, ctx)
    expect(tracer.spans).toHaveLength(2)
    expect(tracer.spans[1]!.name).toBe("gen_ai.chat")
  })
})

describe("orphaned span cleanup", () => {
  test("pending tool spans are ended with ERROR on session.idle", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleMessagePartUpdated(makeToolPartUpdated("running", { sessionID: "ses_1" }), ctx)
    expect(ctx.pendingToolSpans.size).toBe(1)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    expect(ctx.pendingToolSpans.size).toBe(0)
    const toolSpan = tracer.spans.find(s => s.name.startsWith("opencode.tool"))!
    expect(toolSpan.ended).toBe(true)
    expect(toolSpan.status.code).toBe(SpanStatusCode.ERROR)
  })

  test("pending tool spans for other sessions are not swept", () => {
    const { ctx } = makeCtx()
    const t = makeTracer()
    const span = t.startSpan("tool") as unknown as Span
    ctx.pendingToolSpans.set("ses_other:call_1", { tool: "bash", sessionID: "ses_other", startMs: 0, span })
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    expect(ctx.pendingToolSpans.has("ses_other:call_1")).toBe(true)
  })

  test("pending tool spans are ended with ERROR on session.error", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    handleMessagePartUpdated(makeToolPartUpdated("running", { sessionID: "ses_1" }), ctx)
    handleSessionError(makeSessionError("ses_1"), ctx)
    expect(ctx.pendingToolSpans.size).toBe(0)
    const toolSpan = tracer.spans.find(s => s.name.startsWith("opencode.tool"))!
    expect(toolSpan.ended).toBe(true)
    expect(toolSpan.status.code).toBe(SpanStatusCode.ERROR)
  })

  test("pending message spans are ended with ERROR on session.idle", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    startMessageSpan("ses_1", "msg_orphan", "claude", "anthropic", 1000, ctx)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    expect(ctx.messageSpans.has("msg_orphan")).toBe(false)
    const msgSpan = tracer.spans.find(s => s.name === "gen_ai.chat")!
    expect(msgSpan.ended).toBe(true)
    expect(msgSpan.status.code).toBe(SpanStatusCode.ERROR)
  })

  test("pending message spans are ended with ERROR on session.error", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    startMessageSpan("ses_1", "msg_orphan", "claude", "anthropic", 1000, ctx)
    handleSessionError(makeSessionError("ses_1"), ctx)
    expect(ctx.messageSpans.has("msg_orphan")).toBe(false)
    const msgSpan = tracer.spans.find(s => s.name === "gen_ai.chat")!
    expect(msgSpan.ended).toBe(true)
    expect(msgSpan.status.code).toBe(SpanStatusCode.ERROR)
  })
})
