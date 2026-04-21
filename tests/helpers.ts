import type { HandlerContext, Instruments } from "../src/types.ts"
import type { Logger as OtelLogger, LogRecord } from "@opentelemetry/api-logs"
import type { Counter, Histogram, Span, SpanOptions, Tracer, Context, SpanContext, SpanStatus, Attributes } from "@opentelemetry/api"
import { SpanStatusCode, trace } from "@opentelemetry/api"

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

function makeSpan(name: string, startTime?: number, parentSpan?: SpySpan): SpySpan {
  const span: SpySpan = {
    name,
    startTime,
    endTime: undefined,
    ended: false,
    status: { code: SpanStatusCode.UNSET },
    attributes: {},
    parentSpan,
    setStatus(s) { span.status = s; return span },
    setAttribute(k, v) { span.attributes[k] = v; return span },
    setAttributes(attrs) { Object.assign(span.attributes, attrs); return span },
    end(t) { span.ended = true; span.endTime = t },
    isRecording() { return !span.ended },
    spanContext() { return { traceId: "00000000000000000000000000000001", spanId: "0000000000000001", traceFlags: 1 } },
    addEvent() { return span },
    recordException() { return span },
    updateName(n) { span.name = n; return span },
  }
  return span
}

export function makeTracer(): SpyTracer {
  const tracer: SpyTracer = {
    spans: [],
    startSpan(name, options, ctx) {
      const parentFromCtx = ctx ? trace.getSpan(ctx) as SpySpan | undefined : undefined
      const span = makeSpan(
        name,
        typeof options?.startTime === "number" ? options.startTime : undefined,
        parentFromCtx,
      )
      if (options?.attributes) Object.assign(span.attributes, options.attributes)
      tracer.spans.push(span)
      return span
    },
  }
  return tracer
}

export type MockContext = {
  ctx: HandlerContext
  counters: {
    session: SpyCounter
    token: SpyCounter
    cost: SpyCounter
    lines: SpyCounter
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
  }
  gauges: {
    sessionToken: SpyHistogram
    sessionCost: SpyHistogram
  }
  logger: SpyLogger
  pluginLog: SpyPluginLog
  tracer: SpyTracer
}

export function makeCtx(projectID = "proj_test", disabledMetrics: string[] = [], disabledTraces: string[] = []): MockContext {
  const session = makeCounter()
  const token = makeCounter()
  const cost = makeCounter()
  const lines = makeCounter()
  const commit = makeCounter()
  const cache = makeCounter()
  const message = makeCounter()
  const modelUsage = makeCounter()
  const retry = makeCounter()
  const subtask = makeCounter()
  const toolHistogram = makeHistogram()
  const sessionDurationHistogram = makeHistogram()
  const sessionTokenGauge = makeHistogram()
  const sessionCostGauge = makeHistogram()
  const logger = makeLogger()
  const pluginLog = makePluginLog()
  const tracer = makeTracer()

  const instruments: Instruments = {
    sessionCounter: session as unknown as Counter,
    tokenCounter: token as unknown as Counter,
    costCounter: cost as unknown as Counter,
    linesCounter: lines as unknown as Counter,
    commitCounter: commit as unknown as Counter,
    toolDurationHistogram: toolHistogram as unknown as Histogram,
    cacheCounter: cache as unknown as Counter,
    sessionDurationHistogram: sessionDurationHistogram as unknown as Histogram,
    messageCounter: message as unknown as Counter,
    sessionTokenGauge: sessionTokenGauge as unknown as Histogram,
    sessionCostGauge: sessionCostGauge as unknown as Histogram,
    modelUsageCounter: modelUsage as unknown as Counter,
    retryCounter: retry as unknown as Counter,
    subtaskCounter: subtask as unknown as Counter,
  }

  const ctx: HandlerContext = {
    logger: logger as unknown as OtelLogger,
    log: pluginLog.fn,
    instruments,
    commonAttrs: { "project.id": projectID },
    pendingToolSpans: new Map(),
    pendingPermissions: new Map(),
    sessionTotals: new Map(),
    disabledMetrics: new Set(disabledMetrics),
    disabledTraces: new Set(disabledTraces),
    tracer: tracer as unknown as Tracer,
    tracePrefix: "opencode.",
    sessionSpans: new Map(),
    messageSpans: new Map(),
    sessionInputs: new Map(),
    messageOutputs: new Map(),
  }

  return {
    ctx,
    counters: { session, token, cost, lines, commit, cache, message, modelUsage, retry, subtask },
    histograms: { tool: toolHistogram, sessionDuration: sessionDurationHistogram },
    gauges: { sessionToken: sessionTokenGauge, sessionCost: sessionCostGauge },
    logger,
    pluginLog,
    tracer,
  }
}
