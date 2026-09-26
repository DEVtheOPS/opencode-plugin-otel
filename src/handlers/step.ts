import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanKind, SpanStatusCode } from "@opentelemetry/api"
import {
  AGENT_NAME,
  INPUT_MIME_TYPE,
  INPUT_VALUE,
  LLM_COST_TOTAL,
  LLM_INPUT_MESSAGES,
  LLM_MODEL_NAME,
  LLM_OUTPUT_MESSAGES,
  LLM_PROVIDER,
  LLM_SYSTEM,
  LLM_TOKEN_COUNT_COMPLETION,
  LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING,
  LLM_TOKEN_COUNT_PROMPT,
  LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ,
  LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE,
  LLM_TOKEN_COUNT_TOTAL,
  MimeType,
  OpenInferenceSpanKind,
  SemanticConventions,
  SESSION_ID,
} from "@arizeai/openinference-semantic-conventions"
import type { EventOf, HandlerContext, SessionTotals } from "../types.ts"
import { ensureSession } from "./session.ts"
import {
  agentAttrs,
  errorSummary,
  genAiProviderName,
  isMetricEnabled,
  isTraceEnabled,
  resolveRunContext,
  setBoundedMap,
} from "../util.ts"

const OPENINFERENCE_SPAN_KIND = SemanticConventions.OPENINFERENCE_SPAN_KIND
const LLM_FINISH_REASON = "llm.finish_reason"

function billedTokens(tokens: { input: number; output: number; reasoning: number } | undefined): number {
  return (tokens?.input ?? 0) + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)
}

function allTokens(tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } | undefined): number {
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

function accumulateTotals(
  sessionID: string,
  tokens: number,
  cost: number,
  incrementMessages: boolean,
  ctx: HandlerContext,
) {
  const existing = ctx.tracing.sessionTotals.get(sessionID)
  if (!existing) return
  const next: SessionTotals = {
    ...existing,
    tokens: existing.tokens + tokens,
    cost: existing.cost + cost,
    messages: existing.messages + (incrementMessages ? 1 : 0),
  }
  setBoundedMap(ctx.tracing.sessionTotals, sessionID, next)
}

/** Starts an LLM span for a step and records the model/agent metadata for the request. */
export function handleStepStarted(e: EventOf<"session.step.started">, ctx: HandlerContext) {
  const d = e.data
  const totals = ensureSession(d.sessionID, e.created, ctx)
  const agentType = totals.agentType
  setBoundedMap(ctx.tracing.stepMeta, d.assistantMessageID, {
    sessionID: d.sessionID,
    agent: d.agent,
    agentType,
    modelID: d.model.id,
    providerID: d.model.providerID,
  })
  if (totals && totals.agent !== d.agent) {
    setBoundedMap(ctx.tracing.sessionTotals, d.sessionID, { ...totals, agent: d.agent })
  }

  if (!isTraceEnabled("llm", ctx)) return
  const promptText = ctx.tracing.pendingPrompts.get(d.sessionID)?.text

  const span = ctx.tracer.startSpan(
    `${ctx.tracePrefix}llm`,
    {
      startTime: d.started ?? e.created,
      kind: SpanKind.CLIENT,
      attributes: {
        [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
        [SESSION_ID]: d.sessionID,
        [AGENT_NAME]: d.agent,
        "agent.type": agentType,
        [LLM_SYSTEM]: d.model.providerID,
        [LLM_PROVIDER]: d.model.providerID,
        "gen_ai.provider.name": genAiProviderName(d.model.providerID),
        [LLM_MODEL_NAME]: d.model.id,
        ...(promptText
          ? {
              [INPUT_VALUE]: promptText,
              [INPUT_MIME_TYPE]: MimeType.TEXT,
              [LLM_INPUT_MESSAGES]: JSON.stringify([{ role: "user", content: promptText }]),
            }
          : {}),
        ...ctx.commonAttrs,
      },
    },
    resolveRunContext(d.sessionID, ctx),
  )
  setBoundedMap(ctx.tracing.stepSpans, d.assistantMessageID, span)
  setBoundedMap(ctx.tracing.stepSpanContexts, d.assistantMessageID, span.spanContext())
  setBoundedMap(ctx.tracing.activeLlm, d.sessionID, {
    agent: d.agent,
    modelID: d.model.id,
    providerID: d.model.providerID,
    spanContext: span.spanContext(),
  })
}

/** Records token/cost/cache metrics for a completed step and emits an `api_request` log. */
export function handleStepEnded(e: EventOf<"session.step.ended">, ctx: HandlerContext) {
  const d = e.data
  const meta = ctx.tracing.stepMeta.get(d.assistantMessageID)
  const sessionTotals = ctx.tracing.sessionTotals.get(d.sessionID)
  const agent = meta?.agent ?? sessionTotals?.agent ?? "unknown"
  const agentType = meta?.agentType ?? sessionTotals?.agentType ?? "unknown"
  const modelID = meta?.modelID ?? "unknown"
  const providerID = meta?.providerID ?? "unknown"

  recordUsageMetrics(d.sessionID, modelID, agent, d.tokens, d.cost, ctx)
  const firstStep = !ctx.tracing.countedMessages.has(d.assistantMessageID)
  if (firstStep) {
    ctx.tracing.countedMessages.add(d.assistantMessageID)
    if (isMetricEnabled("message.count", ctx)) {
      ctx.instruments.messageCounter.add(1, { ...ctx.commonAttrs, "session.id": d.sessionID, model: modelID, agent })
    }
    if (isMetricEnabled("model.usage", ctx)) {
      ctx.instruments.modelUsageCounter.add(1, {
        ...ctx.commonAttrs,
        "session.id": d.sessionID,
        model: modelID,
        provider: providerID,
        agent,
      })
    }
  }
  accumulateTotals(d.sessionID, allTokens(d.tokens), d.cost, firstStep, ctx)

  const span = ctx.tracing.stepSpans.get(d.assistantMessageID)
  if (span) {
    span.setAttributes({
      [AGENT_NAME]: agent,
      "agent.type": agentType,
      [LLM_TOKEN_COUNT_PROMPT]: d.tokens.input,
      [LLM_TOKEN_COUNT_COMPLETION]: d.tokens.output,
      [LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING]: d.tokens.reasoning,
      [LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]: d.tokens.cache.read,
      [LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE]: d.tokens.cache.write,
      [LLM_TOKEN_COUNT_TOTAL]: allTokens(d.tokens),
      [LLM_FINISH_REASON]: d.finish,
      [LLM_COST_TOTAL]: d.cost,
      cost_usd: d.cost,
    })
    span.setStatus({ code: SpanStatusCode.OK })
    span.end(e.created)
  }
  cleanupStep(d.assistantMessageID, d.sessionID, ctx)

  ctx.emitLog({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: e.created,
    observedTimestamp: Date.now(),
    body: "api_request",
    attributes: {
      "event.name": "api_request",
      "session.id": d.sessionID,
      model: modelID,
      provider: providerID,
      "gen_ai.provider.name": genAiProviderName(providerID),
      ...agentAttrs(agent, agentType),
      cost_usd: d.cost,
      input_tokens: d.tokens.input,
      output_tokens: d.tokens.output,
      reasoning_tokens: d.tokens.reasoning,
      cache_read_tokens: d.tokens.cache.read,
      cache_creation_tokens: d.tokens.cache.write,
      ...ctx.commonAttrs,
    },
  })
}

/** Records token/cost metrics for a failed step and emits an `api_error` log. */
export function handleStepFailed(e: EventOf<"session.step.failed">, ctx: HandlerContext) {
  const d = e.data
  const meta = ctx.tracing.stepMeta.get(d.assistantMessageID)
  const sessionTotals = ctx.tracing.sessionTotals.get(d.sessionID)
  const agent = meta?.agent ?? sessionTotals?.agent ?? "unknown"
  const agentType = meta?.agentType ?? sessionTotals?.agentType ?? "unknown"
  const modelID = meta?.modelID ?? "unknown"
  const providerID = meta?.providerID ?? "unknown"
  const error = errorSummary(d.error)

  if (d.tokens) recordUsageMetrics(d.sessionID, modelID, agent, d.tokens, d.cost ?? 0, ctx)
  if (!ctx.tracing.countedMessages.has(d.assistantMessageID)) {
    ctx.tracing.countedMessages.add(d.assistantMessageID)
    accumulateTotals(d.sessionID, allTokens(d.tokens), d.cost ?? 0, true, ctx)
  } else {
    accumulateTotals(d.sessionID, allTokens(d.tokens), d.cost ?? 0, false, ctx)
  }

  const span = ctx.tracing.stepSpans.get(d.assistantMessageID)
  if (span) {
    span.setAttributes({ [AGENT_NAME]: agent, "agent.type": agentType, [LLM_FINISH_REASON]: d.finish ?? "error" })
    span.setStatus({ code: SpanStatusCode.ERROR, message: error })
    span.end(e.created)
  }
  cleanupStep(d.assistantMessageID, d.sessionID, ctx)

  ctx.emitLog({
    severityNumber: SeverityNumber.ERROR,
    severityText: "ERROR",
    timestamp: e.created,
    observedTimestamp: Date.now(),
    body: "api_error",
    attributes: {
      "event.name": "api_error",
      "session.id": d.sessionID,
      model: modelID,
      provider: providerID,
      "gen_ai.provider.name": genAiProviderName(providerID),
      ...agentAttrs(agent, agentType),
      error,
      ...ctx.commonAttrs,
    },
  })
}

function recordUsageMetrics(
  sessionID: string,
  modelID: string,
  agent: string,
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } | undefined,
  cost: number,
  ctx: HandlerContext,
) {
  if (!tokens) return
  const base = { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, agent }
  if (isMetricEnabled("token.usage", ctx)) {
    const { tokenCounter } = ctx.instruments
    tokenCounter.add(tokens.input, { ...base, type: "input" })
    tokenCounter.add(tokens.output, { ...base, type: "output" })
    tokenCounter.add(tokens.reasoning, { ...base, type: "reasoning" })
    tokenCounter.add(tokens.cache.read, { ...base, type: "cacheRead" })
    tokenCounter.add(tokens.cache.write, { ...base, type: "cacheCreation" })
  }
  if (isMetricEnabled("cost.usage", ctx)) {
    ctx.instruments.costCounter.add(cost, base)
  }
  if (isMetricEnabled("cache.count", ctx)) {
    if (tokens.cache.read > 0) ctx.instruments.cacheCounter.add(1, { ...base, type: "cacheRead" })
    if (tokens.cache.write > 0) ctx.instruments.cacheCounter.add(1, { ...base, type: "cacheCreation" })
  }
  void ctx.log("debug", "otel: step usage recorded", {
    sessionID,
    model: modelID,
    agent,
    billed: billedTokens(tokens),
    cost_usd: cost,
  })
}

function cleanupStep(assistantMessageID: string, sessionID: string, ctx: HandlerContext) {
  ctx.tracing.stepSpans.delete(assistantMessageID)
  ctx.tracing.stepSpanContexts.delete(assistantMessageID)
  ctx.tracing.stepMeta.delete(assistantMessageID)
  ctx.tracing.activeLlm.delete(sessionID)
}
