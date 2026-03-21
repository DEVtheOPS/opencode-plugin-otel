import { describe, test, expect } from "bun:test"
import { handleMessageUpdated, handleMessagePartUpdated } from "../../src/handlers/message.ts"
import { makeCtx } from "../helpers.ts"
import type { EventMessageUpdated, EventMessagePartUpdated } from "@opencode-ai/sdk"

function makeSubtaskPartUpdated(overrides: {
  sessionID?: string
  agent?: string
  description?: string
  prompt?: string
} = {}): EventMessagePartUpdated {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "subtask",
        sessionID: overrides.sessionID ?? "ses_1",
        messageID: "msg_1",
        agent: overrides.agent ?? "build",
        description: overrides.description ?? "Build the project",
        prompt: overrides.prompt ?? "Run the build and fix errors",
      },
    },
  } as unknown as EventMessagePartUpdated
}

function makeAssistantMessageUpdated(overrides: {
  sessionID?: string
  modelID?: string
  providerID?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  time?: { created: number; completed: number }
  error?: { name: string }
}): EventMessageUpdated {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: "msg_1",
        role: "assistant",
        sessionID: overrides.sessionID ?? "ses_1",
        modelID: overrides.modelID ?? "claude-3-5-sonnet",
        providerID: overrides.providerID ?? "anthropic",
        cost: overrides.cost ?? 0.01,
        tokens: overrides.tokens ?? {
          input: 100,
          output: 50,
          reasoning: 0,
          cache: { read: 10, write: 5 },
        },
        time: overrides.time ?? { created: 1000, completed: 2000 },
        error: overrides.error,
      },
    },
  } as unknown as EventMessageUpdated
}

function makeUserMessageUpdated(): EventMessageUpdated {
  return {
    type: "message.updated",
    properties: { info: { id: "msg_1", role: "user" } },
  } as unknown as EventMessageUpdated
}

function makeIncompleteAssistantMessage(): EventMessageUpdated {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: "msg_1",
        role: "assistant",
        sessionID: "ses_1",
        modelID: "claude",
        providerID: "anthropic",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1000, completed: undefined },
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
        ? { status: "completed", time: { start, end }, output: "result output" }
        : { status: "error", time: { start, end }, error: "tool failed" }

  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        sessionID,
        callID,
        tool: overrides.tool ?? "bash",
        state,
      },
    },
  } as unknown as EventMessagePartUpdated
}

describe("handleMessageUpdated", () => {
  test("ignores user messages", async () => {
    const { ctx, counters } = makeCtx()
    await handleMessageUpdated(makeUserMessageUpdated(), ctx)
    expect(counters.token.calls).toHaveLength(0)
  })

  test("ignores incomplete assistant messages", async () => {
    const { ctx, counters } = makeCtx()
    await handleMessageUpdated(makeIncompleteAssistantMessage(), ctx)
    expect(counters.token.calls).toHaveLength(0)
  })

  test("increments all token counters", async () => {
    const { ctx, counters } = makeCtx()
    await handleMessageUpdated(
      makeAssistantMessageUpdated({
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
      }),
      ctx,
    )
    const types = counters.token.calls.map((c) => c.attrs["type"])
    expect(types).toContain("input")
    expect(types).toContain("output")
    expect(types).toContain("reasoning")
    expect(types).toContain("cacheRead")
    expect(types).toContain("cacheCreation")
    const inputCall = counters.token.calls.find((c) => c.attrs["type"] === "input")!
    expect(inputCall.value).toBe(100)
  })

  test("increments cost counter", async () => {
    const { ctx, counters } = makeCtx()
    await handleMessageUpdated(makeAssistantMessageUpdated({ cost: 0.05 }), ctx)
    expect(counters.cost.calls).toHaveLength(1)
    expect(counters.cost.calls.at(0)!.value).toBe(0.05)
  })

  test("increments cache counter once per message with cache activity", async () => {
    const { ctx, counters } = makeCtx()
    await handleMessageUpdated(
      makeAssistantMessageUpdated({ tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 200, write: 50 } } }),
      ctx,
    )
    const types = counters.cache.calls.map(c => c.attrs["type"])
    expect(types).toContain("cacheRead")
    expect(types).toContain("cacheCreation")
    expect(counters.cache.calls.find(c => c.attrs["type"] === "cacheRead")!.value).toBe(1)
    expect(counters.cache.calls.find(c => c.attrs["type"] === "cacheCreation")!.value).toBe(1)
  })

  test("does not increment cache counter when cache tokens are zero", async () => {
    const { ctx, counters } = makeCtx()
    await handleMessageUpdated(
      makeAssistantMessageUpdated({ tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } } }),
      ctx,
    )
    expect(counters.cache.calls).toHaveLength(0)
  })

  test("increments message counter", async () => {
    const { ctx, counters } = makeCtx()
    await handleMessageUpdated(makeAssistantMessageUpdated({ sessionID: "ses_1", modelID: "claude-3-5-sonnet" }), ctx)
    expect(counters.message.calls).toHaveLength(1)
    expect(counters.message.calls.at(0)!.value).toBe(1)
    expect(counters.message.calls.at(0)!.attrs["session.id"]).toBe("ses_1")
  })

  test("increments model usage counter with session.id, model and provider", async () => {
    const { ctx, counters } = makeCtx()
    await handleMessageUpdated(
      makeAssistantMessageUpdated({ sessionID: "ses_1", modelID: "claude-3-5-sonnet", providerID: "anthropic" }),
      ctx,
    )
    expect(counters.modelUsage.calls).toHaveLength(1)
    const call = counters.modelUsage.calls.at(0)!
    expect(call.attrs["session.id"]).toBe("ses_1")
    expect(call.attrs["model"]).toBe("claude-3-5-sonnet")
    expect(call.attrs["provider"]).toBe("anthropic")
  })

  test("accumulates session totals including cache tokens", async () => {
    const { ctx } = makeCtx()
    ctx.sessionTotals.set("ses_1", { startMs: 0, tokens: 0, cost: 0, messages: 0, agent: "build" })
    await handleMessageUpdated(
      makeAssistantMessageUpdated({
        sessionID: "ses_1",
        cost: 0.02,
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
      }),
      ctx,
    )
    const totals = ctx.sessionTotals.get("ses_1")!
    expect(totals.tokens).toBe(185)
    expect(totals.cost).toBe(0.02)
    expect(totals.messages).toBe(1)
  })

  test("emits api_request log record on success", async () => {
    const { ctx, logger } = makeCtx()
    await handleMessageUpdated(makeAssistantMessageUpdated({}), ctx)
    expect(logger.records).toHaveLength(1)
    expect(logger.records.at(0)!.body).toBe("api_request")
  })

  test("emits api_error log record on error", async () => {
    const { ctx, logger, pluginLog } = makeCtx()
    await handleMessageUpdated(
      makeAssistantMessageUpdated({ error: { name: "APIError" } }),
      ctx,
    )
    expect(logger.records.at(0)!.body).toBe("api_error")
    expect(logger.records.at(0)!.attributes?.["error"]).toBe("APIError")
    expect(pluginLog.calls.find(c => c.level === "error")?.level).toBe("error")
  })

  test("uses assistant.time.created as log timestamp", async () => {
    const { ctx, logger } = makeCtx()
    await handleMessageUpdated(
      makeAssistantMessageUpdated({ time: { created: 5000, completed: 6000 } }),
      ctx,
    )
    expect(logger.records.at(0)!.timestamp).toBe(5000)
  })
})

describe("handleMessagePartUpdated", () => {
  test("ignores non-tool parts", async () => {
    const { ctx, histograms } = makeCtx()
    const e = {
      type: "message.part.updated",
      properties: { part: { type: "text", text: "hello", sessionID: "ses_1" } },
    } as unknown as EventMessagePartUpdated
    await handleMessagePartUpdated(e, ctx)
    expect(histograms.tool.calls).toHaveLength(0)
  })

  test("stores running tool in pendingToolSpans", async () => {
    const { ctx } = makeCtx()
    await handleMessagePartUpdated(makeToolPartUpdated("running", { startMs: 1234 }), ctx)
    expect(ctx.pendingToolSpans.has("ses_1:call_1")).toBe(true)
    expect(ctx.pendingToolSpans.get("ses_1:call_1")!.startMs).toBe(1234)
  })

  test("records histogram on tool completion", async () => {
    const { ctx, histograms } = makeCtx()
    await handleMessagePartUpdated(makeToolPartUpdated("running", { startMs: 1000 }), ctx)
    await handleMessagePartUpdated(makeToolPartUpdated("completed", { startMs: 1000, endMs: 1500 }), ctx)
    expect(histograms.tool.calls).toHaveLength(1)
    expect(histograms.tool.calls.at(0)!.value).toBe(500)
    expect(histograms.tool.calls.at(0)!.attrs["tool_name"]).toBe("bash")
    expect(histograms.tool.calls.at(0)!.attrs["success"]).toBe(true)
  })

  test("uses stored startMs from running span for duration", async () => {
    const { ctx, histograms } = makeCtx()
    await handleMessagePartUpdated(makeToolPartUpdated("running", { startMs: 900 }), ctx)
    await handleMessagePartUpdated(makeToolPartUpdated("completed", { startMs: 1000, endMs: 1900 }), ctx)
    expect(histograms.tool.calls.at(0)!.value).toBe(1000)
  })

  test("emits tool_result log on success", async () => {
    const { ctx, logger } = makeCtx()
    await handleMessagePartUpdated(makeToolPartUpdated("running"), ctx)
    await handleMessagePartUpdated(makeToolPartUpdated("completed"), ctx)
    const record = logger.records.at(0)!
    expect(record.body).toBe("tool_result")
    expect(record.attributes?.["success"]).toBe(true)
    expect(record.attributes?.["tool_result_size_bytes"]).toBeGreaterThan(0)
  })

  test("emits error-severity log on tool error", async () => {
    const { ctx, logger, pluginLog } = makeCtx()
    await handleMessagePartUpdated(makeToolPartUpdated("running"), ctx)
    await handleMessagePartUpdated(makeToolPartUpdated("error"), ctx)
    const record = logger.records.at(0)!
    expect(record.body).toBe("tool_result")
    expect(record.attributes?.["success"]).toBe(false)
    expect(record.attributes?.["error"]).toBe("tool failed")
    expect(pluginLog.calls.find(c => c.level === "error")?.level).toBe("error")
  })

  test("removes entry from pendingToolSpans after completion", async () => {
    const { ctx } = makeCtx()
    await handleMessagePartUpdated(makeToolPartUpdated("running"), ctx)
    expect(ctx.pendingToolSpans.size).toBe(1)
    await handleMessagePartUpdated(makeToolPartUpdated("completed"), ctx)
    expect(ctx.pendingToolSpans.size).toBe(0)
  })

  test("skips recording when time.end is undefined", async () => {
    const { ctx, histograms } = makeCtx()
    const e = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "ses_1",
          callID: "call_1",
          tool: "bash",
          state: { status: "completed", time: { start: 1000, end: undefined }, output: "ok" },
        },
      },
    } as unknown as EventMessagePartUpdated
    await handleMessagePartUpdated(e, ctx)
    expect(histograms.tool.calls).toHaveLength(0)
  })
})

describe("handleMessageUpdated — agent attribute", () => {
  test("includes agent attr on token counters from session totals", async () => {
    const { ctx, counters } = makeCtx()
    ctx.sessionTotals.set("ses_1", { startMs: 0, tokens: 0, cost: 0, messages: 0, agent: "plan" })
    await handleMessageUpdated(makeAssistantMessageUpdated({ sessionID: "ses_1" }), ctx)
    const inputCall = counters.token.calls.find((c) => c.attrs["type"] === "input")!
    expect(inputCall.attrs["agent"]).toBe("plan")
  })

  test("includes agent attr on cost counter", async () => {
    const { ctx, counters } = makeCtx()
    ctx.sessionTotals.set("ses_1", { startMs: 0, tokens: 0, cost: 0, messages: 0, agent: "build" })
    await handleMessageUpdated(makeAssistantMessageUpdated({ sessionID: "ses_1" }), ctx)
    expect(counters.cost.calls.at(0)!.attrs["agent"]).toBe("build")
  })

  test("includes agent attr on message counter", async () => {
    const { ctx, counters } = makeCtx()
    ctx.sessionTotals.set("ses_1", { startMs: 0, tokens: 0, cost: 0, messages: 0, agent: "general" })
    await handleMessageUpdated(makeAssistantMessageUpdated({ sessionID: "ses_1" }), ctx)
    expect(counters.message.calls.at(0)!.attrs["agent"]).toBe("general")
  })

  test("includes agent attr on model usage counter", async () => {
    const { ctx, counters } = makeCtx()
    ctx.sessionTotals.set("ses_1", { startMs: 0, tokens: 0, cost: 0, messages: 0, agent: "review" })
    await handleMessageUpdated(makeAssistantMessageUpdated({ sessionID: "ses_1" }), ctx)
    expect(counters.modelUsage.calls.at(0)!.attrs["agent"]).toBe("review")
  })

  test("includes agent attr on cache counters", async () => {
    const { ctx, counters } = makeCtx()
    ctx.sessionTotals.set("ses_1", { startMs: 0, tokens: 0, cost: 0, messages: 0, agent: "tdd" })
    await handleMessageUpdated(
      makeAssistantMessageUpdated({ sessionID: "ses_1", tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 5 } } }),
      ctx,
    )
    expect(counters.cache.calls.at(0)!.attrs["agent"]).toBe("tdd")
  })

  test("defaults agent to 'unknown' when session totals are absent", async () => {
    const { ctx, counters } = makeCtx()
    await handleMessageUpdated(makeAssistantMessageUpdated({ sessionID: "ses_no_totals" }), ctx)
    const inputCall = counters.token.calls.find((c) => c.attrs["type"] === "input")!
    expect(inputCall.attrs["agent"]).toBe("unknown")
  })

  test("includes agent on api_request log record", async () => {
    const { ctx, logger } = makeCtx()
    ctx.sessionTotals.set("ses_1", { startMs: 0, tokens: 0, cost: 0, messages: 0, agent: "plan" })
    await handleMessageUpdated(makeAssistantMessageUpdated({ sessionID: "ses_1" }), ctx)
    expect(logger.records.at(0)!.attributes?.["agent"]).toBe("plan")
  })

  test("includes agent on api_error log record", async () => {
    const { ctx, logger } = makeCtx()
    ctx.sessionTotals.set("ses_1", { startMs: 0, tokens: 0, cost: 0, messages: 0, agent: "build" })
    await handleMessageUpdated(
      makeAssistantMessageUpdated({ sessionID: "ses_1", error: { name: "APIError" } }),
      ctx,
    )
    expect(logger.records.at(0)!.attributes?.["agent"]).toBe("build")
  })
})

describe("handleMessagePartUpdated — subtask parts", () => {
  test("increments subtask counter with agent and session.id attrs", async () => {
    const { ctx, counters } = makeCtx()
    await handleMessagePartUpdated(makeSubtaskPartUpdated({ sessionID: "ses_1", agent: "build" }), ctx)
    expect(counters.subtask.calls).toHaveLength(1)
    const call = counters.subtask.calls.at(0)!
    expect(call.value).toBe(1)
    expect(call.attrs["agent"]).toBe("build")
    expect(call.attrs["session.id"]).toBe("ses_1")
  })

  test("emits subtask_invoked log record", async () => {
    const { ctx, logger } = makeCtx()
    await handleMessagePartUpdated(
      makeSubtaskPartUpdated({ agent: "plan", description: "Plan the feature", prompt: "Create a plan" }),
      ctx,
    )
    expect(logger.records).toHaveLength(1)
    const record = logger.records.at(0)!
    expect(record.body).toBe("subtask_invoked")
    expect(record.attributes?.["agent"]).toBe("plan")
    expect(record.attributes?.["description"]).toBe("Plan the feature")
    expect(record.attributes?.["prompt_length"]).toBe("Create a plan".length)
  })

  test("includes project.id in subtask counter attrs", async () => {
    const { ctx, counters } = makeCtx("proj_xyz")
    await handleMessagePartUpdated(makeSubtaskPartUpdated(), ctx)
    expect(counters.subtask.calls.at(0)!.attrs["project.id"]).toBe("proj_xyz")
  })

  test("does not record subtask counter when subtask.count is disabled", async () => {
    const { ctx, counters } = makeCtx("proj_test", ["subtask.count"])
    await handleMessagePartUpdated(makeSubtaskPartUpdated(), ctx)
    expect(counters.subtask.calls).toHaveLength(0)
  })

  test("still emits subtask_invoked log when subtask.count is disabled", async () => {
    const { ctx, logger } = makeCtx("proj_test", ["subtask.count"])
    await handleMessagePartUpdated(makeSubtaskPartUpdated(), ctx)
    expect(logger.records.at(0)!.body).toBe("subtask_invoked")
  })

  test("does not affect tool handling for non-subtask non-tool parts", async () => {
    const { ctx, counters, histograms } = makeCtx()
    const e = {
      type: "message.part.updated",
      properties: { part: { type: "text", text: "hello", sessionID: "ses_1" } },
    } as unknown as EventMessagePartUpdated
    await handleMessagePartUpdated(e, ctx)
    expect(counters.subtask.calls).toHaveLength(0)
    expect(histograms.tool.calls).toHaveLength(0)
  })
})
