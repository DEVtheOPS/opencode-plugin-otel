import type { HandlerContext, Instruments } from "../src/types.ts"
import type { Logger as OtelLogger, LogRecord } from "@opentelemetry/api-logs"
import type { Counter, Histogram } from "@opentelemetry/api"

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
}

export function makeCtx(projectID = "proj_test", disabledMetrics: string[] = []): MockContext {
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
  }

  return {
    ctx,
    counters: { session, token, cost, lines, commit, cache, message, modelUsage, retry, subtask },
    histograms: { tool: toolHistogram, sessionDuration: sessionDurationHistogram },
    gauges: { sessionToken: sessionTokenGauge, sessionCost: sessionCostGauge },
    logger,
    pluginLog,
  }
}
