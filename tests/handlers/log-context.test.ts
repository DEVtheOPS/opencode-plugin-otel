import { describe, expect, test } from "bun:test"
import { trace } from "@opentelemetry/api"
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { finalizeSession, handleExecutionEnded, handleExecutionStarted, handlePromptEnqueued, handleSessionCreated } from "../../src/handlers/session.ts"
import { handleStepEnded, handleStepFailed, handleStepStarted } from "../../src/handlers/step.ts"
import { handleToolCalled, handleToolFailed, handleToolInputStarted, handleToolSuccess } from "../../src/handlers/tool.ts"
import { evt, makeCtx, tokens } from "../helpers.ts"

function seed(ctx: ReturnType<typeof makeCtx>["ctx"], sessionID = "session", messageID = "message") {
  handleSessionCreated(evt("session.created", { sessionID, agent: "build" }), ctx)
  handleExecutionStarted(evt("session.execution.started", { sessionID }), ctx)
  handleStepStarted(evt("session.step.started", {
    sessionID,
    assistantMessageID: messageID,
    agent: "build",
    model: { id: "model", providerID: "provider" },
  }), ctx)
}

describe("native log trace context", () => {
  test("keeps a queued prompt uncorrelated with the preceding execution", () => {
    const { ctx, logger, tracer } = makeCtx()
    seed(ctx)
    const previousRun = ctx.tracing.runSpans.get("session")!
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "session", inboxID: "queued",
      item: { type: "user", payload: { text: "next execution" }, delivery: "queue" },
    }), ctx, false)
    const record = logger.records.at(-1)!
    expect(record.body).toBe("user_prompt")
    expect(record.context).toBeUndefined()
    handleExecutionEnded(evt("session.execution.succeeded", { sessionID: "session" }), ctx, { type: "succeeded" })
    finalizeSession("session", ctx)
    handleExecutionStarted(evt("session.execution.started", { sessionID: "session" }), ctx)
    const nextRun = tracer.spans.at(-1)!
    expect(nextRun.attributes["input.value"]).toBe("next execution")
    expect(nextRun.spanContext().spanId).not.toBe(previousRun.spanContext().spanId)
    expect(record.context).toBeUndefined()
  })

  test("correlates a steering prompt with its active execution", () => {
    const { ctx, logger } = makeCtx()
    seed(ctx)
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "session", inboxID: "steering",
      item: { type: "user", payload: { text: "adjust current execution" }, delivery: "steer" },
    }), ctx, false)
    expect(trace.getSpanContext(logger.records.at(-1)!.context!)).toEqual(
      ctx.tracing.runSpans.get("session")!.spanContext(),
    )
    expect(ctx.tracing.activePrompts.get("session")?.text).toBe("adjust current execution")
    expect(ctx.tracing.pendingPrompts.has("session")).toBe(false)
  })

  test("leaves a steering prompt without an active execution uncorrelated", () => {
    const { ctx, logger } = makeCtx()
    handleSessionCreated(evt("session.created", { sessionID: "session", agent: "build" }), ctx)
    handlePromptEnqueued(evt("session.inbox.enqueued", {
      sessionID: "session", inboxID: "initial",
      item: { type: "user", payload: { text: "start execution" }, delivery: "steer" },
    }), ctx, false)
    expect(logger.records.at(-1)!.context).toBeUndefined()
    expect(ctx.tracing.pendingPrompts.get("session")?.[0]?.text).toBe("start execution")
  })

  for (const failed of [false, true]) {
    test(`captures the completed LLM context before cleanup (${failed ? "failure" : "success"})`, () => {
      const { ctx, logger, tracer } = makeCtx()
      seed(ctx)
      const data = { sessionID: "session", assistantMessageID: "message", finish: "stop", cost: 1, tokens: tokens() }
      if (failed) handleStepFailed(evt("session.step.failed", { ...data, error: { type: "error", message: "failed" } }), ctx)
      else handleStepEnded(evt("session.step.ended", data), ctx)
      const span = tracer.spans.find(item => item.name === "opencode.llm")!
      const record = logger.records.at(-1)!
      expect(trace.getSpanContext(record.context!)).toEqual(span.spanContext())
      expect(span.ended).toBe(true)
      expect(ctx.tracing.stepSpans.size).toBe(0)
      expect(ctx.tracing.stepSpanContexts.size).toBe(0)
    })

    test(`uses the exact tool context with overlapping calls (${failed ? "failure" : "success"})`, () => {
      const { ctx, logger, tracer } = makeCtx()
      seed(ctx)
      for (const id of ["first", "second"]) {
        handleToolInputStarted(evt("session.tool.input.started", { sessionID: "session", assistantMessageID: "message", id, name: "shell" }), ctx)
        handleToolCalled(evt("session.tool.called", { sessionID: "session", assistantMessageID: "message", id, input: { command: "git commit -m test" } }), ctx)
      }
      const data = { sessionID: "session", assistantMessageID: "message", id: "first", content: [{ type: "text", text: "result" }] }
      if (failed) handleToolFailed(evt("session.tool.failed", { ...data, error: { type: "error", message: "failed" } }), ctx)
      else handleToolSuccess(evt("session.tool.success", data), ctx)
      const span = tracer.spans.find(item => item.attributes["tool.id"] === "first")!
      const record = logger.records.at(-1)!
      expect(trace.getSpanContext(record.context!)).toEqual(span.spanContext())
      expect(span.ended).toBe(true)
      expect(ctx.tracing.toolSpans.has("first")).toBe(false)
      expect(ctx.tracing.toolSpans.has("second")).toBe(true)
      if (!failed) {
        const commit = logger.records.find(item => item.body === "commit")!
        expect(trace.getSpanContext(commit.context!)).toEqual(span.spanContext())
      }
    })
  }

  test("uses the failed execution context after its run span ends", () => {
    const { ctx, logger, tracer } = makeCtx()
    seed(ctx)
    handleExecutionEnded(evt("session.execution.failed", { sessionID: "session" }), ctx, {
      type: "failed", error: { type: "error", message: "failed" },
    })
    const span = tracer.spans.find(item => item.name === "opencode.session")!
    expect(trace.getSpanContext(logger.records.at(-1)!.context!)).toEqual(span.spanContext())
    expect(ctx.tracing.runSpans.size).toBe(0)
  })

  test("falls back to the run when LLM spans are disabled", () => {
    const { ctx, logger, tracer } = makeCtx("project", [], ["llm"])
    seed(ctx)
    handleStepEnded(evt("session.step.ended", { sessionID: "session", assistantMessageID: "message", finish: "stop", cost: 1, tokens: tokens() }), ctx)
    const span = tracer.spans.find(item => item.name === "opencode.session")!
    expect(trace.getSpanContext(logger.records.at(-1)!.context!)).toEqual(span.spanContext())
  })

  test("does not invent context with tracing disabled or a missed start event", () => {
    for (const disabled of [[], ["session", "llm", "tool"]]) {
      const { ctx, logger, tracer } = makeCtx("project", [], disabled)
      if (disabled.length) seed(ctx)
      handleStepEnded(evt("session.step.ended", { sessionID: "session", assistantMessageID: "message", finish: "stop", cost: 1, tokens: tokens() }), ctx)
      expect(trace.getSpanContext(logger.records.at(-1)!.context!)).toBeUndefined()
      expect(tracer.spans).toHaveLength(0)
    }
  })

  test("keeps contexts isolated between sessions", () => {
    const { ctx, logger, tracer } = makeCtx()
    seed(ctx, "first", "message-first")
    seed(ctx, "second", "message-second")
    handleStepEnded(evt("session.step.ended", { sessionID: "first", assistantMessageID: "message-first", finish: "stop", cost: 1, tokens: tokens() }), ctx)
    const span = tracer.spans.find(item => item.name === "opencode.llm" && item.attributes["session.id"] === "first")!
    expect(trace.getSpanContext(logger.records.at(-1)!.context!)).toEqual(span.spanContext())
  })

  test("does not enable logs when the content policy disables them", () => {
    const { ctx, logger } = makeCtx("project", [], [], false)
    seed(ctx)
    handleStepEnded(evt("session.step.ended", { sessionID: "session", assistantMessageID: "message", finish: "stop", cost: 1, tokens: tokens() }), ctx)
    expect(logger.records).toHaveLength(0)
  })

  test("exports native traceId and spanId with the real logs SDK", async () => {
    const { ctx, logger, tracer } = makeCtx()
    const exporter = new InMemoryLogRecordExporter()
    const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] })
    try {
      seed(ctx)
      handleStepEnded(evt("session.step.ended", { sessionID: "session", assistantMessageID: "message", finish: "stop", cost: 1, tokens: tokens() }), ctx)
      provider.getLogger("test").emit(logger.records.at(-1)!)
      await provider.forceFlush()
      const span = tracer.spans.find(item => item.name === "opencode.llm")!
      const record = exporter.getFinishedLogRecords()[0]!
      expect(record.spanContext?.traceId).toBe(span.spanContext().traceId)
      expect(record.spanContext?.spanId).toBe(span.spanContext().spanId)
      expect(record.attributes["trace_id"]).toBeUndefined()
    } finally {
      await provider.shutdown()
    }
  })
})
