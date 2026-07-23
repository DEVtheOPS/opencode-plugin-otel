import { describe, test, expect } from "bun:test"
import { context, SpanStatusCode, trace, TraceFlags } from "@opentelemetry/api"
import {
  AGENT_NAME,
  LLM_MODEL_NAME,
  LLM_PROVIDER,
  LLM_SYSTEM,
  LLM_TOKEN_COUNT_COMPLETION,
  LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING,
  LLM_TOKEN_COUNT_PROMPT,
  LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ,
  LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE,
  OpenInferenceSpanKind,
  SemanticConventions,
  SESSION_ID,
  TOOL_NAME,
} from "@arizeai/openinference-semantic-conventions"
import type { Span } from "@opentelemetry/api"
import { handleSessionCreated, handleSessionIdle, handleSessionError, handleRunStarted } from "../../src/handlers/session.ts"
import { handleMessageUpdated, handleMessagePartUpdated, startMessageSpan } from "../../src/handlers/message.ts"
import { remoteParentContext } from "../../src/trace-context.ts"
import { makeCtx, makeTracer, type SpySpan } from "../helpers.ts"
import type {
  EventSessionCreated,
  EventSessionIdle,
  EventSessionError,
  EventMessageUpdated,
  EventMessagePartUpdated,
} from "@opencode-ai/sdk"

const OPENINFERENCE_SPAN_KIND = SemanticConventions.OPENINFERENCE_SPAN_KIND

function makeSessionCreated(sessionID: string, createdAt = 1000, parentID?: string): EventSessionCreated {
  return {
    type: "session.created",
    properties: { info: { id: sessionID, projectID: "proj_test", directory: "/tmp", parentID, time: { created: createdAt } } },
  } as unknown as EventSessionCreated
}

function makeSessionIdle(sessionID: string): EventSessionIdle {
  return { type: "session.idle", properties: { sessionID } } as EventSessionIdle
}

function makeSessionError(sessionID?: string, error?: { name: string }): EventSessionError {
  return {
    type: "session.error",
    properties: { ...(sessionID !== undefined ? { sessionID } : {}), error },
  } as unknown as EventSessionError
}

function makeAssistantMessageUpdated(overrides: {
  id?: string
  parentID?: string
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
        parentID: overrides.parentID ?? "user_1",
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
  overrides: { sessionID?: string; messageID?: string; callID?: string; tool?: string; startMs?: number; endMs?: number; output?: string } = {},
): EventMessagePartUpdated {
  const sessionID = overrides.sessionID ?? "ses_1"
  const messageID = overrides.messageID ?? "msg_1"
  const callID = overrides.callID ?? "call_1"
  const start = overrides.startMs ?? 1000
  const end = overrides.endMs ?? 2000
  const state =
    status === "running"
      ? { status: "running", time: { start } }
      : status === "completed"
        ? { status: "completed", time: { start, end }, output: overrides.output ?? "ok" }
        : { status: "error", time: { start, end }, error: "fail" }
  return {
    type: "message.part.updated",
    properties: { part: { type: "tool", sessionID, messageID, callID, tool: overrides.tool ?? "bash", state } },
  } as unknown as EventMessagePartUpdated
}

describe("session spans", () => {
  test("does not start a root trace span on session.created for primary sessions", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_1", 5000), ctx)
    expect(tracer.spans).toHaveLength(0)
    expect(ctx.sessionSpans.has("ses_1")).toBe(false)
  })

  test("subagent session span carries session.id attribute", () => {
    const { ctx, tracer } = makeCtx("proj_test", [], [], true, { team: "platform" })
    handleRunStarted("user_parent", "ses_parent", "build", "prompt", "anthropic/claude", 900, ctx)
    handleSessionCreated(makeSessionCreated("ses_1", 1000, "ses_parent"), ctx)
    expect(tracer.spans[1]!.attributes["session.id"]).toBe("ses_1")
    expect(tracer.spans[1]!.attributes[SESSION_ID]).toBe("ses_1")
    expect(tracer.spans[1]!.attributes["team"]).toBe("platform")
  })

  test("run span is tagged as an OpenInference agent span", () => {
    const { ctx, tracer } = makeCtx()
    handleRunStarted("user_1", "ses_1", "build", "prompt", "anthropic/claude", 1000, ctx)
    expect(tracer.spans[0]!.attributes[OPENINFERENCE_SPAN_KIND]).toBe(OpenInferenceSpanKind.AGENT)
    expect(tracer.spans[0]!.attributes[AGENT_NAME]).toBe("build")
  })

  test("run span carries is_subagent=false for root session", () => {
    const { ctx, tracer } = makeCtx()
    handleRunStarted("user_root", "ses_root", "build", "prompt", "anthropic/claude", 1000, ctx)
    expect(tracer.spans[0]!.attributes["session.is_subagent"]).toBe(false)
  })

  test("session span carries is_subagent=true for subagent session", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_child", 1000, "ses_parent"), ctx)
    expect(tracer.spans[0]!.attributes["session.is_subagent"]).toBe(true)
  })

  test("run span is parented to injected remote context", () => {
    const { ctx, tracer } = makeCtx()
    const rootContext = remoteParentContext("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", undefined)
    expect(rootContext).toBeDefined()
    ctx.rootContext = () => rootContext!
    handleRunStarted("user_1", "ses_1", "build", "prompt", "anthropic/claude", 1000, ctx)
    expect(tracer.spans[0]!.parentSpanContext?.traceId).toBe("0af7651916cd43dd8448eb211c80319c")
    expect(tracer.spans[0]!.parentSpanContext?.spanId).toBe("b7ad6b7169203331")
  })

  test("run span resolves root context at span creation", () => {
    const { ctx, tracer } = makeCtx()
    let rootContext = context.active()
    ctx.rootContext = () => rootContext
    rootContext = trace.setSpanContext(context.active(), {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: TraceFlags.SAMPLED,
    })
    handleRunStarted("user_1", "ses_1", "build", "prompt", "anthropic/claude", 1000, ctx)
    expect(tracer.spans[0]!.parentSpanContext?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736")
    expect(tracer.spans[0]!.parentSpanContext?.spanId).toBe("00f067aa0ba902b7")
  })

  test("ends run span with OK status on session.idle", () => {
    const { ctx, tracer } = makeCtx()
    handleRunStarted("user_1", "ses_1", "build", "prompt", "anthropic/claude", 1000, ctx)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    const span = tracer.spans[0]!
    expect(span.ended).toBe(true)
    expect(span.status.code).toBe(SpanStatusCode.OK)
    expect(ctx.runSpans.has("user_1")).toBe(false)
  })

  test("sets session total attributes on the run span before ending on idle", () => {
    const { ctx, tracer } = makeCtx()
    handleRunStarted("user_1", "ses_1", "build", "prompt", "anthropic/claude", 1000, ctx)
    ctx.sessionTotals.set("ses_1", { startMs: Date.now() - 100, tokens: 250, cost: 0.05, messages: 3, agent: "build", agentType: "primary" })
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    const span = tracer.spans[0]!
    expect(span.attributes["session.total_tokens"]).toBe(250)
    expect(span.attributes["session.total_cost_usd"]).toBe(0.05)
    expect(span.attributes["session.total_messages"]).toBe(3)
    expect(span.attributes[AGENT_NAME]).toBe("build")
    expect(span.attributes["agent.type"]).toBe("primary")
  })

  test("ends run span with ERROR status on session.error", () => {
    const { ctx, tracer } = makeCtx()
    handleRunStarted("user_1", "ses_1", "build", "prompt", "anthropic/claude", 1000, ctx)
    handleSessionError(makeSessionError("ses_1", { name: "NetworkError" }), ctx)
    const span = tracer.spans[0]!
    expect(span.ended).toBe(true)
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(ctx.runSpans.has("user_1")).toBe(false)
  })

  test("error message is propagated to run span status", () => {
    const { ctx, tracer } = makeCtx()
    handleRunStarted("user_1", "ses_1", "build", "prompt", "anthropic/claude", 1000, ctx)
    handleSessionError(makeSessionError("ses_1", { name: "TimeoutError" }), ctx)
    expect(tracer.spans[0]!.status.message).toBe("TimeoutError")
  })

  test("idle on unknown session does not throw and creates no span", () => {
    const { ctx, tracer } = makeCtx()
    expect(() => handleSessionIdle(makeSessionIdle("ses_unknown"), ctx)).not.toThrow()
    expect(tracer.spans).toHaveLength(0)
  })

  test("session.error with undefined sessionID does not end any span", () => {
    const { ctx, tracer } = makeCtx()
    handleRunStarted("user_1", "ses_1", "build", "prompt", "anthropic/claude", 1000, ctx)
    handleSessionError(makeSessionError(undefined, { name: "UnknownError" }), ctx)
    expect(ctx.runSpans.has("user_1")).toBe(true)
    expect(tracer.spans[0]!.ended).toBe(false)
  })

  test("subagent span is parented to the active run span", () => {
    const { ctx, tracer } = makeCtx()
    handleRunStarted("user_parent", "ses_parent", "build", "prompt", "anthropic/claude", 1000, ctx)
    handleSessionCreated(makeSessionCreated("ses_child", 2000, "ses_parent"), ctx)
    expect(tracer.spans).toHaveLength(2)
    expect(tracer.spans[1]!.name).toBe("opencode.session")
    expect(tracer.spans[1]!.parentSpan).toBe(tracer.spans[0])
  })

  test("subagent span falls back to a root trace when parent run is absent", () => {
    const { ctx, tracer } = makeCtx()
    expect(() => handleSessionCreated(makeSessionCreated("ses_child", 1000, "ses_missing_parent"), ctx)).not.toThrow()
    expect(tracer.spans).toHaveLength(1)
    expect(tracer.spans[0]!.parentSpan).toBeUndefined()
    expect(tracer.spans[0]!.parentSpanContext).toBeUndefined()
  })

  test("late child spans reuse the ended run trace context", () => {
    const { ctx, tracer } = makeCtx()
    handleRunStarted("user_1", "ses_1", "build", "prompt", "anthropic/claude", 1000, ctx)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    startMessageSpan("ses_1", "msg_late", "user_1", "claude", "anthropic", 2000, ctx)
    expect(tracer.spans).toHaveLength(2)
    expect(tracer.spans[1]!.parentSpanContext).toBeDefined()
    expect(tracer.spans[1]!.parentSpanContext?.spanId).toBe(tracer.spans[0]!.spanContext().spanId)
    expect(tracer.spans[1]!.parentSpanContext?.traceId).toBe(tracer.spans[0]!.spanContext().traceId)
  })

  test("late child events stay on the previous run after a new run starts", () => {
    const { ctx, tracer } = makeCtx()
    handleRunStarted("user_1", "ses_1", "build", "prompt one", "anthropic/claude", 1000, ctx)
    startMessageSpan("ses_1", "msg_1", "user_1", "claude", "anthropic", 1100, ctx)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    handleRunStarted("user_2", "ses_1", "build", "prompt two", "anthropic/claude", 2000, ctx)
    handleMessagePartUpdated(makeToolPartUpdated("running", { sessionID: "ses_1", messageID: "msg_1", callID: "call_late" }), ctx)
    expect(tracer.spans).toHaveLength(4)
    expect(tracer.spans[3]!.name).toBe("opencode.tool.bash")
    expect(tracer.spans[3]!.parentSpanContext?.spanId).toBe(tracer.spans[0]!.spanContext().spanId)
    expect(tracer.spans[3]!.parentSpanContext?.spanId).not.toBe(tracer.spans[2]!.spanContext().spanId)
  })
})

describe("tool spans", () => {
  test("starts a tool span on running status", () => {
    const { ctx, tracer } = makeCtx()
    handleMessagePartUpdated(makeToolPartUpdated("running", { startMs: 1000 }), ctx)
    expect(tracer.spans).toHaveLength(1)
    expect(tracer.spans[0]!.name).toBe("opencode.tool.bash")
    expect(tracer.spans[0]!.startTime).toBe(1000)
    expect(ctx.pendingToolSpans.has("ses_1:call_1")).toBe(true)
  })

  test("tool span carries tool.name attribute", () => {
    const { ctx, tracer } = makeCtx()
    ctx.sessionTotals.set("ses_1", { startMs: 0, tokens: 0, cost: 0, messages: 0, agent: "build", agentType: "primary" })
    handleMessagePartUpdated(makeToolPartUpdated("running", { tool: "read_file" }), ctx)
    expect(tracer.spans[0]!.attributes["tool.name"]).toBe("read_file")
    expect(tracer.spans[0]!.attributes[TOOL_NAME]).toBe("read_file")
    expect(tracer.spans[0]!.attributes[OPENINFERENCE_SPAN_KIND]).toBe(OpenInferenceSpanKind.TOOL)
    expect(tracer.spans[0]!.attributes[AGENT_NAME]).toBe("build")
    expect(tracer.spans[0]!.attributes["agent.type"]).toBe("primary")
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

  test("tool span result_size_bytes matches exact byte length of multibyte output", () => {
    const { ctx, tracer } = makeCtx()
    const multibyte = "こんにちは"
    const expectedBytes = Buffer.byteLength(multibyte, "utf8")
    handleMessagePartUpdated(makeToolPartUpdated("running"), ctx)
    handleMessagePartUpdated(makeToolPartUpdated("completed", { output: multibyte }), ctx)
    expect(tracer.spans[0]!.attributes["tool.result_size_bytes"]).toBe(expectedBytes)
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
    handleRunStarted("user_1", "ses_1", "build", "prompt", "anthropic/claude", 900, ctx)
    handleMessagePartUpdated(makeToolPartUpdated("running", { sessionID: "ses_1" }), ctx)
    expect(tracer.spans).toHaveLength(2)
    expect(tracer.spans[1]!.name).toBe("opencode.tool.bash")
    expect(tracer.spans[1]!.parentSpan).toBe(tracer.spans[0])
  })

  test("out-of-order tool span is parented to session span when available", () => {
    const { ctx, tracer } = makeCtx()
    handleRunStarted("user_1", "ses_1", "build", "prompt", "anthropic/claude", 900, ctx)
    handleMessagePartUpdated(makeToolPartUpdated("completed", { sessionID: "ses_1", startMs: 500, endMs: 1500 }), ctx)
    expect(tracer.spans).toHaveLength(2)
    expect(tracer.spans[1]!.name).toBe("opencode.tool.bash")
    expect(tracer.spans[1]!.parentSpan).toBe(tracer.spans[0])
  })
})

describe("message (LLM) spans", () => {
  test("startMessageSpan creates an llm span", () => {
    const { ctx, tracer } = makeCtx()
    startMessageSpan("ses_1", "msg_1", "user_1", "claude-3-5-sonnet", "anthropic", 1000, ctx, "build")
    expect(tracer.spans).toHaveLength(1)
    expect(tracer.spans[0]!.name).toBe("opencode.llm")
    expect(ctx.messageSpans.has("ses_1:msg_1")).toBe(true)
    expect(ctx.llmRequestContexts.get("ses_1:user_1")).toMatchObject({
      messageID: "msg_1",
      agent: "build",
      modelID: "claude-3-5-sonnet",
      providerID: "anthropic",
    })
  })

  test("startMessageSpan sets OpenInference LLM attributes", () => {
    const { ctx, tracer } = makeCtx()
    startMessageSpan("ses_1", "msg_1", "user_1", "claude-sonnet-4", "amazon-bedrock", 1000, ctx)
    expect(tracer.spans[0]!.attributes[OPENINFERENCE_SPAN_KIND]).toBe(OpenInferenceSpanKind.LLM)
    expect(tracer.spans[0]!.attributes[LLM_SYSTEM]).toBe("amazon-bedrock")
    expect(tracer.spans[0]!.attributes[LLM_PROVIDER]).toBe("amazon-bedrock")
    expect(tracer.spans[0]!.attributes["gen_ai.provider.name"]).toBe("aws.bedrock")
    expect(tracer.spans[0]!.attributes[LLM_MODEL_NAME]).toBe("claude-sonnet-4")
  })

  test("startMessageSpan is a no-op when span already exists for sessionID:messageID", () => {
    const { ctx, tracer } = makeCtx()
    startMessageSpan("ses_1", "msg_1", "user_1", "claude", "anthropic", 1000, ctx)
    startMessageSpan("ses_1", "msg_1", "user_1", "claude", "anthropic", 1000, ctx)
    expect(tracer.spans).toHaveLength(1)
  })

  test("handleMessageUpdated ends message span on completion", () => {
    const { ctx, tracer } = makeCtx()
    startMessageSpan("ses_1", "msg_1", "user_1", "claude-3-5-sonnet", "anthropic", 1000, ctx)
    handleMessageUpdated(makeAssistantMessageUpdated({ id: "msg_1", time: { created: 1000, completed: 2000 } }), ctx)
    const span = tracer.spans[0]!
    expect(span.ended).toBe(true)
    expect(span.endTime).toBe(2000)
    expect(ctx.messageSpans.has("ses_1:msg_1")).toBe(false)
    expect(ctx.llmRequestContexts.has("ses_1:user_1")).toBe(false)
  })

  test("an older completion does not remove a newer request context", () => {
    const { ctx } = makeCtx()
    startMessageSpan("ses_1", "msg_1", "user_1", "claude", "anthropic", 1000, ctx)
    startMessageSpan("ses_1", "msg_2", "user_1", "claude", "anthropic", 1500, ctx)

    handleMessageUpdated(makeAssistantMessageUpdated({ id: "msg_1", time: { created: 1000, completed: 2000 } }), ctx)

    expect(ctx.llmRequestContexts.get("ses_1:user_1")?.messageID).toBe("msg_2")
  })

  test("handleMessageUpdated sets OK status on success", () => {
    const { ctx, tracer } = makeCtx()
    startMessageSpan("ses_1", "msg_1", "user_1", "claude-3-5-sonnet", "anthropic", 1000, ctx)
    handleMessageUpdated(makeAssistantMessageUpdated({ id: "msg_1" }), ctx)
    expect(tracer.spans[0]!.status.code).toBe(SpanStatusCode.OK)
  })

  test("handleMessageUpdated sets ERROR status on api error", () => {
    const { ctx, tracer } = makeCtx()
    startMessageSpan("ses_1", "msg_1", "user_1", "claude-3-5-sonnet", "anthropic", 1000, ctx)
    handleMessageUpdated(makeAssistantMessageUpdated({ id: "msg_1", error: { name: "RateLimitError" } }), ctx)
    expect(tracer.spans[0]!.status.code).toBe(SpanStatusCode.ERROR)
    expect(tracer.spans[0]!.status.message).toBe("RateLimitError")
  })

  test("handleMessageUpdated sets OpenInference token attributes on span", () => {
    const { ctx, tracer } = makeCtx()
    startMessageSpan("ses_1", "msg_1", "user_1", "claude-3-5-sonnet", "anthropic", 1000, ctx)
    ctx.sessionTotals.set("ses_1", { startMs: 0, tokens: 0, cost: 0, messages: 0, agent: "review", agentType: "subagent" })
    handleMessageUpdated(
      makeAssistantMessageUpdated({
        id: "msg_1",
        tokens: { input: 200, output: 80, reasoning: 10, cache: { read: 30, write: 5 } },
      }),
      ctx,
    )
    const span = tracer.spans[0]!
    expect(span.attributes[LLM_TOKEN_COUNT_PROMPT]).toBe(200)
    expect(span.attributes[LLM_TOKEN_COUNT_COMPLETION]).toBe(80)
    expect(span.attributes[LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING]).toBe(10)
    expect(span.attributes[LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]).toBe(30)
    expect(span.attributes[LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE]).toBe(5)
    expect(span.attributes[AGENT_NAME]).toBe("review")
    expect(span.attributes["agent.type"]).toBe("subagent")
  })

  test("handleMessageUpdated no-ops span handling when no span exists for messageID", () => {
    const { ctx, tracer } = makeCtx()
    const spansBefore = tracer.spans.length
    const mapSizeBefore = ctx.messageSpans.size
    handleMessageUpdated(makeAssistantMessageUpdated({ id: "msg_no_span" }), ctx)
    expect(tracer.spans).toHaveLength(spansBefore)
    expect(ctx.messageSpans.size).toBe(mapSizeBefore)
  })

  test("message span is parented to session span when available", () => {
    const { ctx, tracer } = makeCtx()
    handleRunStarted("user_1", "ses_1", "build", "prompt", "anthropic/claude", 900, ctx)
    startMessageSpan("ses_1", "msg_1", "user_1", "claude", "anthropic", 1000, ctx)
    expect(tracer.spans).toHaveLength(2)
    expect(tracer.spans[1]!.name).toBe("opencode.llm")
    expect(tracer.spans[1]!.parentSpan).toBe(tracer.spans[0])
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
    startMessageSpan("ses_1", "msg_orphan", "user_1", "claude", "anthropic", 1000, ctx)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    expect(ctx.messageSpans.has("ses_1:msg_orphan")).toBe(false)
    expect(ctx.llmRequestContexts.has("ses_1:user_1")).toBe(false)
    const msgSpan = tracer.spans.find(s => s.name === "opencode.llm")!
    expect(msgSpan.ended).toBe(true)
    expect(msgSpan.status.code).toBe(SpanStatusCode.ERROR)
  })

  test("pending message spans are ended with ERROR on session.error", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    startMessageSpan("ses_1", "msg_orphan", "user_1", "claude", "anthropic", 1000, ctx)
    handleSessionError(makeSessionError("ses_1"), ctx)
    expect(ctx.messageSpans.has("ses_1:msg_orphan")).toBe(false)
    const msgSpan = tracer.spans.find(s => s.name === "opencode.llm")!
    expect(msgSpan.ended).toBe(true)
    expect(msgSpan.status.code).toBe(SpanStatusCode.ERROR)
  })
})

describe("OPENCODE_DISABLE_TRACES=session", () => {
  test("no session span is started", () => {
    const { ctx, tracer } = makeCtx("proj_test", [], ["session"])
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(tracer.spans).toHaveLength(0)
    expect(ctx.sessionSpans.has("ses_1")).toBe(false)
  })

  test("session counter metric still fires", () => {
    const { ctx, counters } = makeCtx("proj_test", [], ["session"])
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(counters.session.calls).toHaveLength(1)
  })

  test("session.created log record still emitted", () => {
    const { ctx, logger } = makeCtx("proj_test", [], ["session"])
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(logger.records.find(r => r.body === "session.created")).toBeDefined()
  })

  test("session.idle does not throw when no session span exists", () => {
    const { ctx } = makeCtx("proj_test", [], ["session"])
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(() => handleSessionIdle(makeSessionIdle("ses_1"), ctx)).not.toThrow()
  })

  test("session.error does not throw when no session span exists", () => {
    const { ctx } = makeCtx("proj_test", [], ["session"])
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(() => handleSessionError(makeSessionError("ses_1"), ctx)).not.toThrow()
  })

  test("llm spans become root spans (no parent) when session traces disabled but llm enabled", () => {
    const { ctx, tracer } = makeCtx("proj_test", [], ["session"])
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    startMessageSpan("ses_1", "msg_1", "user_1", "claude", "anthropic", 1000, ctx)
    expect(tracer.spans).toHaveLength(1)
    expect(tracer.spans[0]!.name).toBe("opencode.llm")
    expect(tracer.spans[0]!.parentSpan).toBeUndefined()
  })
})

describe("OPENCODE_DISABLE_TRACES=llm", () => {
  test("startMessageSpan is a no-op", () => {
    const { ctx, tracer } = makeCtx("proj_test", [], ["llm"])
    startMessageSpan("ses_1", "msg_1", "user_1", "claude", "anthropic", 1000, ctx)
    expect(tracer.spans).toHaveLength(0)
    expect(ctx.messageSpans.has("msg_1")).toBe(false)
  })

  test("token counter metrics still fire", () => {
    const { ctx, counters } = makeCtx("proj_test", [], ["llm"])
    handleMessageUpdated(makeAssistantMessageUpdated({ id: "msg_1" }), ctx)
    expect(counters.token.calls.length).toBeGreaterThan(0)
  })

  test("cost counter metric still fires", () => {
    const { ctx, counters } = makeCtx("proj_test", [], ["llm"])
    handleMessageUpdated(makeAssistantMessageUpdated({ id: "msg_1", cost: 0.05 }), ctx)
    expect(counters.cost.calls).toHaveLength(1)
  })

  test("api_request log record still emitted", () => {
    const { ctx, logger } = makeCtx("proj_test", [], ["llm"])
    handleMessageUpdated(makeAssistantMessageUpdated({ id: "msg_1" }), ctx)
    expect(logger.records.find(r => r.body === "api_request")).toBeDefined()
  })

  test("handleMessageUpdated does not throw when no message span exists", () => {
    const { ctx } = makeCtx("proj_test", [], ["llm"])
    expect(() => handleMessageUpdated(makeAssistantMessageUpdated({ id: "msg_1" }), ctx)).not.toThrow()
  })

  test("session spans still created when only llm disabled", () => {
    const { ctx, tracer } = makeCtx("proj_test", [], ["llm"])
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(tracer.spans).toHaveLength(0)
  })
})

describe("OPENCODE_DISABLE_TRACES=tool", () => {
  test("no tool span started on running status", () => {
    const { ctx, tracer } = makeCtx("proj_test", [], ["tool"])
    handleMessagePartUpdated(makeToolPartUpdated("running"), ctx)
    expect(tracer.spans).toHaveLength(0)
  })

  test("pendingToolSpans entry still stored for histogram timing", () => {
    const { ctx } = makeCtx("proj_test", [], ["tool"])
    handleMessagePartUpdated(makeToolPartUpdated("running", { startMs: 1000 }), ctx)
    expect(ctx.pendingToolSpans.has("ses_1:call_1")).toBe(true)
    expect(ctx.pendingToolSpans.get("ses_1:call_1")!.startMs).toBe(1000)
    expect(ctx.pendingToolSpans.get("ses_1:call_1")!.span).toBeUndefined()
  })

  test("tool.duration histogram still records on completion", () => {
    const { ctx, histograms } = makeCtx("proj_test", [], ["tool"])
    handleMessagePartUpdated(makeToolPartUpdated("running", { startMs: 1000 }), ctx)
    handleMessagePartUpdated(makeToolPartUpdated("completed", { startMs: 1000, endMs: 1500 }), ctx)
    expect(histograms.tool.calls).toHaveLength(1)
    expect(histograms.tool.calls[0]!.value).toBe(500)
  })

  test("tool_result log record still emitted on completion", () => {
    const { ctx, logger } = makeCtx("proj_test", [], ["tool"])
    handleMessagePartUpdated(makeToolPartUpdated("running"), ctx)
    handleMessagePartUpdated(makeToolPartUpdated("completed"), ctx)
    expect(logger.records.find(r => r.body === "tool_result")).toBeDefined()
  })

  test("no tool span created for out-of-order completed event", () => {
    const { ctx, tracer } = makeCtx("proj_test", [], ["tool"])
    handleMessagePartUpdated(makeToolPartUpdated("completed", { startMs: 500, endMs: 1500 }), ctx)
    expect(tracer.spans).toHaveLength(0)
  })

  test("session spans still created when only tool disabled", () => {
    const { ctx, tracer } = makeCtx("proj_test", [], ["tool"])
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(tracer.spans).toHaveLength(0)
  })
})
