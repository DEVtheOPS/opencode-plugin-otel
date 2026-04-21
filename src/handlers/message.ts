import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanStatusCode, SpanKind, context, trace } from "@opentelemetry/api"
import type { AssistantMessage, EventMessageUpdated, EventMessagePartUpdated, ToolPart } from "@opencode-ai/sdk"
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
  OUTPUT_MIME_TYPE,
  OUTPUT_VALUE,
  SemanticConventions,
  SESSION_ID,
  TOOL_ID,
  TOOL_NAME,
  TOOL_PARAMETERS,
} from "@arizeai/openinference-semantic-conventions"
import { errorSummary, setBoundedMap, accumulateSessionTotals, isMetricEnabled, isTraceEnabled } from "../util.ts"
import type { HandlerContext } from "../types.ts"

const OPENINFERENCE_SPAN_KIND = SemanticConventions.OPENINFERENCE_SPAN_KIND
const LLM_FINISH_REASON = "llm.finish_reason"

type SubtaskPart = {
  type: "subtask"
  sessionID: string
  messageID: string
  prompt: string
  description: string
  agent: string
}

/**
 * Handles a completed assistant message: increments token and cost counters, emits
 * either an `api_request` or `api_error` log event, and ends the LLM span for this message.
 * The `agent` attribute is sourced from the session totals, which are populated by the
 * `chat.message` hook when the user prompt is received.
 */
export function handleMessageUpdated(e: EventMessageUpdated, ctx: HandlerContext) {
  const msg = e.properties.info
  if (msg.role !== "assistant") return
  const assistant = msg as AssistantMessage
  if (!assistant.time.completed) return

  const { sessionID, modelID, providerID } = assistant
  const duration = assistant.time.completed - assistant.time.created
  const agent = ctx.sessionTotals.get(sessionID)?.agent ?? "unknown"

  const totalTokens = assistant.tokens.input + assistant.tokens.output + assistant.tokens.reasoning
    + assistant.tokens.cache.read + assistant.tokens.cache.write

  if (isMetricEnabled("token.usage", ctx)) {
    const { tokenCounter } = ctx.instruments
    tokenCounter.add(assistant.tokens.input, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, agent, type: "input" })
    tokenCounter.add(assistant.tokens.output, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, agent, type: "output" })
    tokenCounter.add(assistant.tokens.reasoning, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, agent, type: "reasoning" })
    tokenCounter.add(assistant.tokens.cache.read, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, agent, type: "cacheRead" })
    tokenCounter.add(assistant.tokens.cache.write, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, agent, type: "cacheCreation" })
  }

  if (isMetricEnabled("cost.usage", ctx)) {
    ctx.instruments.costCounter.add(assistant.cost, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, agent })
  }

  if (isMetricEnabled("cache.count", ctx)) {
    if (assistant.tokens.cache.read > 0) {
      ctx.instruments.cacheCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, agent, type: "cacheRead" })
    }
    if (assistant.tokens.cache.write > 0) {
      ctx.instruments.cacheCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, agent, type: "cacheCreation" })
    }
  }

  if (isMetricEnabled("message.count", ctx)) {
    ctx.instruments.messageCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, agent })
  }

  if (isMetricEnabled("model.usage", ctx)) {
    ctx.instruments.modelUsageCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID, model: modelID, provider: providerID, agent })
  }

  accumulateSessionTotals(sessionID, totalTokens, assistant.cost, ctx)

  ctx.log("debug", "otel: token+cost counters incremented", {
    sessionID,
    model: modelID,
    agent,
    input: assistant.tokens.input,
    output: assistant.tokens.output,
    reasoning: assistant.tokens.reasoning,
    cacheRead: assistant.tokens.cache.read,
    cacheWrite: assistant.tokens.cache.write,
    cost_usd: assistant.cost,
  })

  const msgKey = `${sessionID}:${assistant.id}`
  const msgSpan = ctx.messageSpans.get(msgKey)
  if (msgSpan) {
    const outputText = ctx.messageOutputs.get(msgKey)
    msgSpan.setAttributes({
      [LLM_TOKEN_COUNT_PROMPT]: assistant.tokens.input,
      [LLM_TOKEN_COUNT_COMPLETION]: assistant.tokens.output,
      [LLM_TOKEN_COUNT_COMPLETION_DETAILS_REASONING]: assistant.tokens.reasoning,
      [LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_READ]: assistant.tokens.cache.read,
      [LLM_TOKEN_COUNT_PROMPT_DETAILS_CACHE_WRITE]: assistant.tokens.cache.write,
      [LLM_TOKEN_COUNT_TOTAL]: totalTokens,
      [LLM_FINISH_REASON]: assistant.error ? "error" : (assistant.finish ?? "stop"),
      [LLM_COST_TOTAL]: assistant.cost,
      ...(outputText
        ? {
            [OUTPUT_VALUE]: outputText,
            [OUTPUT_MIME_TYPE]: MimeType.TEXT,
            [LLM_OUTPUT_MESSAGES]: JSON.stringify([{ role: "assistant", content: outputText }]),
          }
        : {}),
      cost_usd: assistant.cost,
      duration_ms: duration,
    })
    if (assistant.error) {
      msgSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorSummary(assistant.error) })
    } else {
      msgSpan.setStatus({ code: SpanStatusCode.OK })
    }
    msgSpan.end(assistant.time.completed)
    ctx.messageSpans.delete(msgKey)
    ctx.messageOutputs.delete(msgKey)
  }

  if (assistant.error) {
    ctx.logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: "ERROR",
      timestamp: assistant.time.created,
      observedTimestamp: Date.now(),
      body: "api_error",
      attributes: {
        "event.name": "api_error",
        "session.id": sessionID,
        model: modelID,
        provider: providerID,
        agent,
        error: errorSummary(assistant.error),
        duration_ms: duration,
        ...ctx.commonAttrs,
      },
    })
    return ctx.log("error", "otel: api_error", {
      sessionID,
      model: modelID,
      agent,
      error: errorSummary(assistant.error),
      duration_ms: duration,
    })
  }

  ctx.logger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    timestamp: assistant.time.created,
    observedTimestamp: Date.now(),
    body: "api_request",
    attributes: {
      "event.name": "api_request",
      "session.id": sessionID,
      model: modelID,
      provider: providerID,
      agent,
      cost_usd: assistant.cost,
      duration_ms: duration,
      input_tokens: assistant.tokens.input,
      output_tokens: assistant.tokens.output,
      reasoning_tokens: assistant.tokens.reasoning,
      cache_read_tokens: assistant.tokens.cache.read,
      cache_creation_tokens: assistant.tokens.cache.write,
      ...ctx.commonAttrs,
    },
  })
  return ctx.log("info", "otel: api_request", {
    sessionID,
    model: modelID,
    agent,
    cost_usd: assistant.cost,
    duration_ms: duration,
    input_tokens: assistant.tokens.input,
    output_tokens: assistant.tokens.output,
  })
}

/**
 * Tracks tool execution time between `running` and `completed`/`error` part updates,
 * records a `tool.duration` histogram measurement, manages the tool child span, and emits
 * a `tool_result` log event. Also handles `subtask` parts, incrementing the sub-agent
 * invocation counter and emitting a `subtask_invoked` log event.
 *
 * For tool spans: on `running` a child span of the current session span is started and stored
 * in `pendingToolSpans`. On `completed`/`error` the span is ended with appropriate status.
 * If no `running` event was seen (out-of-order), a best-effort span is started and immediately ended.
 */
export function handleMessagePartUpdated(e: EventMessagePartUpdated, ctx: HandlerContext) {
  const part = e.properties.part

  if (part.type === "text") {
    const key = `${part.sessionID}:${part.messageID}`
    ctx.messageOutputs.set(key, `${ctx.messageOutputs.get(key) ?? ""}${part.text}`)
    return
  }

  if (part.type === "subtask") {
    const subtask = part as unknown as SubtaskPart
    if (isMetricEnabled("subtask.count", ctx)) {
      ctx.instruments.subtaskCounter.add(1, {
        ...ctx.commonAttrs,
        "session.id": subtask.sessionID,
        agent: subtask.agent,
      })
    }
    ctx.logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      timestamp: Date.now(),
      observedTimestamp: Date.now(),
      body: "subtask_invoked",
      attributes: {
        "event.name": "subtask_invoked",
        "session.id": subtask.sessionID,
        agent: subtask.agent,
        description: subtask.description,
        prompt_length: subtask.prompt.length,
        ...ctx.commonAttrs,
      },
    })
    return ctx.log("info", "otel: subtask_invoked", {
      sessionID: subtask.sessionID,
      agent: subtask.agent,
      description: subtask.description,
    })
  }

  if (part.type === "tool") {
    const toolPart = part as ToolPart
    const key = `${toolPart.sessionID}:${toolPart.callID}`

    if (toolPart.state.status === "running") {
      const toolSpan = isTraceEnabled("tool", ctx)
        ? (() => {
            const sessionSpan = ctx.sessionSpans.get(toolPart.sessionID)
            const parentCtx = sessionSpan
              ? trace.setSpan(context.active(), sessionSpan)
              : context.active()
            return ctx.tracer.startSpan(
              `${ctx.tracePrefix}tool.${toolPart.tool}`,
              {
                startTime: toolPart.state.time.start,
                kind: SpanKind.INTERNAL,
                attributes: {
                  [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
                  [SESSION_ID]: toolPart.sessionID,
                  [TOOL_ID]: toolPart.callID,
                  [TOOL_NAME]: toolPart.tool,
                  [TOOL_PARAMETERS]: JSON.stringify(toolPart.state.input),
                  [INPUT_VALUE]: JSON.stringify(toolPart.state.input),
                  [INPUT_MIME_TYPE]: MimeType.JSON,
                  ...ctx.commonAttrs,
                },
              },
              parentCtx,
            )
          })()
        : undefined
      setBoundedMap(ctx.pendingToolSpans, key, {
        tool: toolPart.tool,
        sessionID: toolPart.sessionID,
        startMs: toolPart.state.time.start,
        span: toolSpan,
      })
      ctx.log("debug", "otel: tool span started", { sessionID: toolPart.sessionID, tool: toolPart.tool, key })
      return
    }

    if (toolPart.state.status !== "completed" && toolPart.state.status !== "error") return

    const pending = ctx.pendingToolSpans.get(key)
    ctx.pendingToolSpans.delete(key)
    const start = pending?.startMs ?? toolPart.state.time.start
    const end = toolPart.state.time.end
    if (end === undefined) return
    const duration_ms = end - start
    const success = toolPart.state.status === "completed"

    if (isMetricEnabled("tool.duration", ctx)) {
      ctx.instruments.toolDurationHistogram.record(duration_ms, {
        ...ctx.commonAttrs,
        "session.id": toolPart.sessionID,
        tool_name: toolPart.tool,
        success,
      })
    }

    if (isTraceEnabled("tool", ctx)) {
      const toolSpan = pending?.span ?? (() => {
        const sessionSpan = ctx.sessionSpans.get(toolPart.sessionID)
        const parentCtx = sessionSpan
          ? trace.setSpan(context.active(), sessionSpan)
          : context.active()
        return ctx.tracer.startSpan(
          `${ctx.tracePrefix}tool.${toolPart.tool}`,
          {
            startTime: start,
            kind: SpanKind.INTERNAL,
            attributes: {
              [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
              [SESSION_ID]: toolPart.sessionID,
              [TOOL_ID]: toolPart.callID,
              [TOOL_NAME]: toolPart.tool,
              [TOOL_PARAMETERS]: JSON.stringify(toolPart.state.input),
              [INPUT_VALUE]: JSON.stringify(toolPart.state.input),
              [INPUT_MIME_TYPE]: MimeType.JSON,
              ...ctx.commonAttrs,
            },
          },
          parentCtx,
        )
      })()
      toolSpan.setAttribute("tool.success", success)
      if (success) {
        const output = (toolPart.state as { output: string }).output
        toolSpan.setAttributes({
          [OUTPUT_VALUE]: output,
          [OUTPUT_MIME_TYPE]: MimeType.TEXT,
        })
        toolSpan.setAttribute("tool.result_size_bytes", Buffer.byteLength(output, "utf8"))
        toolSpan.setStatus({ code: SpanStatusCode.OK })
      } else {
        const err = (toolPart.state as { error: string }).error
        toolSpan.setAttributes({
          [OUTPUT_VALUE]: err,
          [OUTPUT_MIME_TYPE]: MimeType.TEXT,
        })
        toolSpan.setAttribute("tool.error", err)
        toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: err })
      }
      toolSpan.end(end)
    }

    const sizeAttr = success
      ? { tool_result_size_bytes: Buffer.byteLength((toolPart.state as { output: string }).output, "utf8") }
      : { error: (toolPart.state as { error: string }).error }

    ctx.logger.emit({
      severityNumber: success ? SeverityNumber.INFO : SeverityNumber.ERROR,
      severityText: success ? "INFO" : "ERROR",
      timestamp: start,
      observedTimestamp: Date.now(),
      body: "tool_result",
      attributes: {
        "event.name": "tool_result",
        "session.id": toolPart.sessionID,
        tool_name: toolPart.tool,
        success,
        duration_ms,
        ...sizeAttr,
        ...ctx.commonAttrs,
      },
    })
    ctx.log("debug", "otel: tool.duration histogram recorded", {
      sessionID: toolPart.sessionID,
      tool_name: toolPart.tool,
      duration_ms,
      success,
    })
    return ctx.log(success ? "info" : "error", "otel: tool_result", {
      sessionID: toolPart.sessionID,
      tool_name: toolPart.tool,
      success,
      duration_ms,
    })
  }
}

/**
 * Starts an LLM span for an assistant message when it first appears in `message.updated`.
 * The span is parented to the session span and carries `gen_ai.*` semantic attributes for
 * the model and provider. It is ended in `handleMessageUpdated` once the message completes.
 *
 * Only called for assistant messages that have not yet completed (`time.completed` absent).
 */
export function startMessageSpan(
  sessionID: string,
  messageID: string,
  modelID: string,
  providerID: string,
  startTime: number,
  ctx: HandlerContext,
) {
  if (!isTraceEnabled("llm", ctx)) return
  const msgKey = `${sessionID}:${messageID}`
  if (ctx.messageSpans.has(msgKey)) return
  const sessionSpan = ctx.sessionSpans.get(sessionID)
  const parentCtx = sessionSpan
    ? trace.setSpan(context.active(), sessionSpan)
    : context.active()

  const msgSpan = ctx.tracer.startSpan(
    `${ctx.tracePrefix}llm`,
    {
      startTime,
      kind: SpanKind.CLIENT,
      attributes: {
        [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
        [SESSION_ID]: sessionID,
        [AGENT_NAME]: ctx.sessionTotals.get(sessionID)?.agent ?? "unknown",
        [LLM_SYSTEM]: providerID,
        [LLM_PROVIDER]: providerID,
        [LLM_MODEL_NAME]: modelID,
        ...(ctx.sessionInputs.has(sessionID)
          ? {
              [INPUT_VALUE]: ctx.sessionInputs.get(sessionID)!,
              [INPUT_MIME_TYPE]: MimeType.TEXT,
              [LLM_INPUT_MESSAGES]: JSON.stringify([{ role: "user", content: ctx.sessionInputs.get(sessionID)! }]),
            }
          : {}),
        ...ctx.commonAttrs,
      },
    },
    parentCtx,
  )
  setBoundedMap(ctx.messageSpans, msgKey, msgSpan)
}
