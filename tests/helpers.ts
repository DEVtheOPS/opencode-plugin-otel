import type { HandlerContext, Instruments, TracingState, OpenCodeEvent } from "../src/types.ts"
import type { LogRecord } from "@opentelemetry/api-logs"
import type { Counter, Histogram, Span, SpanOptions, Tracer, Context, SpanContext, SpanStatus, Attributes } from "@opentelemetry/api"
import { ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api"

export type SpyCounter = {
  calls: Array<{ value: number; attrs: Record<string, unknown> }>
  add(value: number, attrs?: Record<string, unknown>): void
}

export type SpyHistogram = {
  calls: Array<{ value: number; attrs: Record<string, unknown> }>
  record(value: number, attrs?: Record<string, unknown>): void
}

export type SpyLogger = {
  records: LogRecord[]
  emit(record: LogRecord): void
}

export type SpyPluginLog = {
  calls: Array<{ level: string; message: string; extra?: Record<string, unknown> }>
  fn: HandlerContext["log"]
}

export type SpySpan = {
  name: string
  startTime?: number
  endTime?: number | undefined
  ended: boolean
  status: SpanStatus
  attributes: Record<string, unknown>
  parentSpan: SpySpan | undefined
  parentSpanContext: SpanContext | undefined
  setStatus(status: SpanStatus): SpySpan
  setAttribute(key: string, value: unknown): SpySpan
  setAttributes(attrs: Attributes): SpySpan
  end(endTime?: number): void
  isRecording(): boolean
  spanContext(): SpanContext
  addEvent(name: string): SpySpan
  recordException(): SpySpan
  updateName(name: string): SpySpan
}

export type SpyTracer = {
  spans: SpySpan[]
  startSpan(name: string, options?: SpanOptions, ctx?: Context): SpySpan
}

function makeCounter(): SpyCounter {
  const spy: SpyCounter = { calls: [], add(v, a = {}) { spy.calls.push({ value: v, attrs: a }) } }
  return spy
}

function makeHistogram(): SpyHistogram {
  const spy: SpyHistogram = { calls: [], record(v, a = {}) { spy.calls.push({ value: v, attrs: a }) } }
  return spy
}

function makeLogger(): SpyLogger {
  const spy: SpyLogger = { records: [], emit(r) { spy.records.push(r) } }
  return spy
}

function makePluginLog(): SpyPluginLog {
  const spy: SpyPluginLog = {
    calls: [],
    fn: async (level, message, extra) => { spy.calls.push({ level, message, extra }) },
  }
  return spy
}

function makeSpan(
  name: string,
  startTime?: number,
  parentSpan?: SpySpan,
  parentSpanContext?: SpanContext,
  ownSpanContext?: SpanContext,
): SpySpan {
  const context = ownSpanContext ?? {
    traceId: "00000000000000000000000000000001",
    spanId: "0000000000000001",
    traceFlags: 1,
  }
  const span: SpySpan = {
    name,
    startTime,
    endTime: undefined,
    ended: false,
    status: { code: SpanStatusCode.UNSET },
    attributes: {},
    parentSpan,
    parentSpanContext,
    setStatus(s) { span.status = s; return span },
    setAttribute(k, v) { span.attributes[k] = v; return span },
    setAttributes(attrs) { Object.assign(span.attributes, attrs); return span },
    end(t) { span.ended = true; span.endTime = t },
    isRecording() { return !span.ended },
    spanContext() { return context },
    addEvent() { return span },
    recordException() { return span },
    updateName(n) { span.name = n; return span },
  }
  return span
}

export function makeTracer(): SpyTracer {
  let nextSpanID = 1
  const tracer: SpyTracer = {
    spans: [],
    startSpan(name, options, ctx) {
      const parentFromCtx = ctx ? trace.getSpan(ctx) as SpySpan | undefined : undefined
      const parentSpanContext = ctx ? trace.getSpanContext(ctx) ?? undefined : undefined
      const ownSpanContext: SpanContext = {
        traceId: parentSpanContext?.traceId ?? "00000000000000000000000000000001",
        spanId: (nextSpanID++).toString(16).padStart(16, "0"),
        traceFlags: parentSpanContext?.traceFlags ?? 1,
        ...(parentSpanContext?.traceState ? { traceState: parentSpanContext.traceState } : {}),
      }
      const span = makeSpan(
        name,
        typeof options?.startTime === "number" ? options.startTime : undefined,
        parentFromCtx,
        parentSpanContext,
        ownSpanContext,
      )
      if (options?.attributes) Object.assign(span.attributes, options.attributes)
      tracer.spans.push(span)
      return span
    },
  }
  return tracer
}

/** Builds a fresh tracing correlation state for a mock context. */
export function makeTracingState(): TracingState {
  return {
    seenEvents: new Set(),
    eventQueue: Promise.resolve(),
    runSpans: new Map(),
    runSpanContexts: new Map(),
    stepSpans: new Map(),
    activeStepSpans: new Map(),
    stepSpanContexts: new Map(),
    toolSpans: new Map(),
    toolSpanContexts: new Map(),
    subagentParents: new Map(),
    consumedSubagentDispatches: new Set(),
    toolMeta: new Map(),
    stepMeta: new Map(),
    sessionTotals: new Map(),
    countedSessions: new Set(),
    countedMessages: new Set(),
    sessionProjects: new Map(),
    sessionIdentity: new Map(),
    stepOutputs: new Map(),
    pendingPrompts: new Map(),
    activePrompts: new Map(),
    activeExecutions: new Set(),
    pendingPermissions: new Map(),
    activeLlm: new Map(),
    provisionalLlm: new Map(),
    modelContexts: new Map(),
  }
}

/** Builds a mock OpenCode V2 event with an id, type, timestamp, and data payload. */
export function evt(type: string, data: Record<string, unknown>, created = 1000, id = `${type}:1`): any {
  return { id, type, created, data } as unknown as OpenCodeEvent
}

export type MockContext = {
  ctx: HandlerContext
  counters: {
    session: SpyCounter
    token: SpyCounter
    cost: SpyCounter
    commit: SpyCounter
    cache: SpyCounter
    message: SpyCounter
    modelUsage: SpyCounter
    retry: SpyCounter
    subtask: SpyCounter
  }
  histograms: {
    tool: SpyHistogram
    sessionDuration: SpyHistogram
    sessionToken: SpyHistogram
    sessionCost: SpyHistogram
  }
  logger: SpyLogger
  pluginLog: SpyPluginLog
  tracer: SpyTracer
}

export function makeCtx(
  projectID = "proj_test",
  disabledMetrics: string[] = [],
  disabledTraces: string[] = [],
  logsEnabled = true,
  extraCommonAttrs: Record<string, string> = {},
): MockContext {
  const session = makeCounter()
  const token = makeCounter()
  const cost = makeCounter()
  const commit = makeCounter()
  const cache = makeCounter()
  const message = makeCounter()
  const modelUsage = makeCounter()
  const retry = makeCounter()
  const subtask = makeCounter()
  const toolHistogram = makeHistogram()
  const sessionDurationHistogram = makeHistogram()
  const sessionTokenHistogram = makeHistogram()
  const sessionCostHistogram = makeHistogram()
  const logger = makeLogger()
  const pluginLog = makePluginLog()
  const tracer = makeTracer()

  const instruments: Instruments = {
    sessionCounter: session as unknown as Counter,
    tokenCounter: token as unknown as Counter,
    costCounter: cost as unknown as Counter,
    commitCounter: commit as unknown as Counter,
    toolDurationHistogram: toolHistogram as unknown as Histogram,
    cacheCounter: cache as unknown as Counter,
    sessionDurationHistogram: sessionDurationHistogram as unknown as Histogram,
    messageCounter: message as unknown as Counter,
    sessionTokenHistogram: sessionTokenHistogram as unknown as Histogram,
    sessionCostHistogram: sessionCostHistogram as unknown as Histogram,
    modelUsageCounter: modelUsage as unknown as Counter,
    retryCounter: retry as unknown as Counter,
    subtaskCounter: subtask as unknown as Counter,
  }

  const ctx: HandlerContext = {
    log: pluginLog.fn,
    emitLog: (record) => {
      if (!logsEnabled) return
      logger.emit(record)
    },
    instruments,
    commonAttrs: { "project.id": projectID, ...extraCommonAttrs },
    disabledMetrics: new Set(disabledMetrics),
    disabledTraces: new Set(disabledTraces),
    tracer: tracer as unknown as Tracer,
    tracePrefix: "opencode.",
    rootContext: () => ROOT_CONTEXT,
    tracing: makeTracingState(),
    tracePropagationProviders: new Set(),
  }

  return {
    ctx,
    counters: { session, token, cost, commit, cache, message, modelUsage, retry, subtask },
    histograms: { tool: toolHistogram, sessionDuration: sessionDurationHistogram, sessionToken: sessionTokenHistogram, sessionCost: sessionCostHistogram },
    logger,
    pluginLog,
    tracer,
  }
}

/** Returns a minimal well-formed V2 token usage sample. */
export function tokens(input = 10, output = 5, reasoning = 0, cacheRead = 0, cacheWrite = 0) {
  return { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } }
}

export type { Span }
