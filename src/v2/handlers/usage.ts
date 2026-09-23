import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanStatusCode, trace } from "@opentelemetry/api"
import {
  INPUT_MIME_TYPE,
  INPUT_VALUE,
  LLM_COST_TOTAL,
  LLM_MODEL_NAME,
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
import { agentAttrs, genAiProviderName, isMetricEnabled, isTraceEnabled, resolveSessionTraceContext, setBoundedMap } from "../util.ts"
import type { HandlerContext } from "../types.ts"
import { errorSummary, modelRef, totalTokens, type V2Error, type V2Model, type V2Tokens } from "../v2.ts"

const OPENINFERENCE_SPAN_KIND = SemanticConventions.OPENINFERENCE_SPAN_KIND
const LLM_FINISH_REASON = "llm.finish_reason"

const stepKey = (sessionID: string, assistantMessageID: string) => `${sessionID}:${assistantMessageID}`

/** Applies the cumulative per-session usage snapshot emitted by V2 `session.usage.updated`. */
export function handleUsageUpdated(
  data: { sessionID: string; cost?: number; tokens?: V2Tokens },
  ctx: HandlerContext,
) {
  const existing = ctx.sessionTotals.get(data.sessionID)
  if (!existing) return
  setBoundedMap(ctx.sessionTotals, data.sessionID, {
    ...existing,
    tokens: totalTokens(data.tokens),
    cost: data.cost ?? 0,
  })
}

/** Starts the LLM step span for an assistant message and records its request context for header injection. */
export function handleStepStarted(
  data: { sessionID: string; assistantMessageID: string; agent?: string; model?: V2Model; started?: number },
  ctx: HandlerContext,
) {
  const agent = data.agent ?? "unknown"
  const modelID = data.model?.id ?? "unknown"
  const providerID = data.model?.providerID ?? "unknown"
  const started = data.started ?? Date.now()
  const runID = ctx.activeRuns.get(data.sessionID)
  if (runID) setBoundedMap(ctx.assistantRuns, data.assistantMessageID, runID)
  setBoundedMap(ctx.sessionMeta, data.sessionID, {
    agent,
    model: modelRef(data.model),
  })
  // Enrich the turn's root span with the model once the first step resolves it.
  const runSpan = runID ? ctx.runSpans.get(runID) : undefined
  if (runSpan) runSpan.setAttribute("model", modelRef(data.model))
  // Propagate the resolved agent into session totals so turn-end logs/spans carry it.
  const totals = ctx.sessionTotals.get(data.sessionID)
  if (totals && agent !== "unknown" && totals.agent !== agent) {
    setBoundedMap(ctx.sessionTotals, data.sessionID, { ...totals, agent })
  }

  // Emit the user_prompt log once per turn, now that agent/model are resolved, linked to
  // the turn's run span so it shares the trace.
  if (runID && !ctx.promptEmitted.has(runID)) {
    ctx.promptEmitted.add(runID)
    const promptText = ctx.runPrompts.get(runID) ?? ""
    const promptContext = runSpan ? trace.setSpan(ctx.rootContext(), runSpan) : undefined
    ctx.emitLog(
      {
        severityNumber: SeverityNumber.INFO,
        severityText: "INFO",
        timestamp: Date.now(),
        observedTimestamp: Date.now(),
        body: "user_prompt",
        attributes: {
          "event.name": "user_prompt",
          "session.id": data.sessionID,
          ...agentAttrs(agent, "primary"),
          prompt_length: promptText.length,
          ...(ctx.capturePromptInLogs ? { prompt: ctx.redact(promptText) } : {}),
          model: modelRef(data.model),
          ...ctx.commonAttrs,
        },
      },
      promptContext,
    )
  }

  if (!isTraceEnabled("llm", ctx)) return
  const span = ctx.tracer.startSpan(
    `${ctx.tracePrefix}llm`,
    {
      startTime: started,
      attributes: {
        [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
        [SESSION_ID]: data.sessionID,
        [LLM_SYSTEM]: providerID,
        [LLM_PROVIDER]: providerID,
        "gen_ai.provider.name": genAiProviderName(providerID),
        [LLM_MODEL_NAME]: modelID,
        agent,
        ...ctx.commonAttrs,
      },
    },
    resolveSessionTraceContext(data.sessionID, ctx, { assistantMessageID: data.assistantMessageID }),
  )
  ctx.stepSpans.set(stepKey(data.sessionID, data.assistantMessageID), {
    span,
    sessionID: data.sessionID,
    agent,
    modelID,
    providerID,
    started,
  })
  const existing = ctx.llmRequestContexts.get(data.sessionID) ?? []
  ctx.llmRequestContexts.set(
    data.sessionID,
    [
      ...existing.slice(-9),
      { messageID: data.assistantMessageID, agent, modelID, providerID, spanContext: span.spanContext() },
    ],
  )
}

/** Ends the LLM step span and records token, cost, cache, and message metrics. */
export function handleStepEnded(
  data: {
    sessionID: string
    assistantMessageID: string
    finish?: string
    cost?: number
    tokens?: V2Tokens
    files?: string[]
  },
  ctx: HandlerContext,
  error?: V2Error,
) {
  const key = stepKey(data.sessionID, data.assistantMessageID)
  const step = ctx.stepSpans.get(key)
  const tokens = data.tokens
  const total = totalTokens(tokens)
  const attrs = { ...ctx.commonAttrs, "session.id": data.sessionID, agent: step?.agent ?? "unknown" }

  if (step) {
    step.span.setAttributes({
      ...(tokens
        ? {
            [LLM_TOKEN_COUNT_PROMPT]: tokens.input,
            [LLM_TOKEN_COUNT_COMPLETION]: tokens.output,
            [LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING]: tokens.reasoning,
            [LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]: tokens.cache.read,
            [LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE]: tokens.cache.write,
            [LLM_TOKEN_COUNT_TOTAL]: total,
          }
        : {}),
      [LLM_FINISH_REASON]: error ? "error" : (data.finish ?? "stop"),
      ...(typeof data.cost === "number" ? { [LLM_COST_TOTAL]: data.cost } : {}),
      ...(data.files ? { "session.files_changed": data.files.length } : {}),
    })
    if (error) {
      step.span.setStatus({ code: SpanStatusCode.ERROR, message: errorSummary(error) })
    } else {
      step.span.setStatus({ code: SpanStatusCode.OK })
    }
    step.span.end()
    ctx.stepSpans.delete(key)
  }

  if (isMetricEnabled("token.usage", ctx)) {
    ctx.instruments.tokenCounter.add(total, {
      ...attrs,
      model: step ? modelRef({ id: step.modelID, providerID: step.providerID }) : "unknown",
    })
  }
  if (tokens && isMetricEnabled("cache.count", ctx)) {
    ctx.instruments.cacheCounter.add(tokens.cache.read + tokens.cache.write, attrs)
  }
  if (typeof data.cost === "number" && isMetricEnabled("cost.usage", ctx)) {
    ctx.instruments.costCounter.add(data.cost, attrs)
  }
  if (isMetricEnabled("model.usage", ctx) && step) {
    ctx.instruments.modelUsageCounter.add(1, {
      ...attrs,
      model: step.modelID,
      provider: step.providerID,
    })
  }
  if (isMetricEnabled("message.count", ctx)) {
    ctx.instruments.messageCounter.add(1, attrs)
  }

  const existing = ctx.sessionTotals.get(data.sessionID)
  if (existing) {
    setBoundedMap(ctx.sessionTotals, data.sessionID, { ...existing, messages: existing.messages + 1 })
  }
}
