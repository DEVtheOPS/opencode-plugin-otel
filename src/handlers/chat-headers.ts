import { SpanKind, type Span } from "@opentelemetry/api"
import { AGENT_NAME, INPUT_MIME_TYPE, INPUT_VALUE, LLM_INPUT_MESSAGES, LLM_MODEL_NAME, LLM_PROVIDER, MimeType, OpenInferenceSpanKind, SemanticConventions, SESSION_ID } from "@arizeai/openinference-semantic-conventions"
import type { HandlerContext } from "../types.ts"
import { injectTraceContext } from "../trace-context.ts"
import { genAiProviderName, isTraceEnabled, resolveRunContext, setBoundedMap } from "../util.ts"
import { ensureRunSpan } from "./session.ts"

/** The `session.hook("model.request", ...)` event shape consumed by this handler. */
export type ModelRequestEvent = {
  sessionID: string
  agent: string
  model: { providerID: string; id: string }
  kind: string
  headers: Record<string, string>
}

type ModelVisibleContextEvent = {
  sessionID: string
  agent: string
  model: { providerID: string; id: string }
  system: readonly unknown[]
  messages: readonly { role: string; content: readonly unknown[] }[]
}

function textParts(parts: readonly unknown[]): string {
  return parts
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .slice(0, 1_000)
}

const ACTIVE_LLM_SETTLE_MS = 200
const ACTIVE_LLM_SETTLE_TICK_MS = 15

/** Stores a bounded text-only preview of the primary model-visible request. */
export function captureModelContext(event: ModelVisibleContextEvent, ctx: HandlerContext): void {
  const entries = [
    ...event.system.slice(-2).map((part) => ({ role: "system", content: textParts([part]) })),
    ...event.messages.slice(-12).map((message) => ({ role: message.role, content: textParts(message.content) })),
  ]
  const latestUser = entries.findLast((entry) => entry.role === "user" && entry.content)
  setBoundedMap(ctx.tracing.modelContexts, event.sessionID, {
    agent: event.agent,
    providerID: event.model.providerID,
    modelID: event.model.id,
    inputMessages: JSON.stringify(entries),
    ...(latestUser ? { inputValue: latestUser.content } : {}),
  })
}

/** Applies a matching captured request preview to its LLM span. */
export function applyModelContext(
  sessionID: string,
  agent: string,
  model: { providerID: string; id: string },
  span: Span,
  ctx: HandlerContext,
  retain = false,
): void {
  const snapshot = ctx.tracing.modelContexts.get(sessionID)
  if (!snapshot || snapshot.agent !== agent || snapshot.providerID !== model.providerID || snapshot.modelID !== model.id) return
  span.setAttributes({
    [LLM_INPUT_MESSAGES]: snapshot.inputMessages,
    ...(snapshot.inputValue ? { [INPUT_VALUE]: snapshot.inputValue, [INPUT_MIME_TYPE]: MimeType.TEXT } : {}),
  })
  if (!retain) ctx.tracing.modelContexts.delete(sessionID)
}

/** Injects the active LLM span's W3C trace context into outbound model requests. */
export async function handleModelRequest(event: ModelRequestEvent, ctx: HandlerContext): Promise<void> {
  const providerID = event.model.providerID
  const propagate = ctx.tracePropagationProviders.has(providerID) || ctx.tracePropagationProviders.has("*")
  if (!propagate && !ctx.tracing.modelContexts.has(event.sessionID)) return
  await ctx.tracing.eventQueue
  if (event.kind !== "primary") {
    if (propagate && isTraceEnabled("session", ctx)) {
      const dispatch = ctx.tracing.subagentParents.get(event.sessionID)
      if (dispatch) {
        injectTraceContext(dispatch.spanContext, event.headers)
      } else if (ctx.tracing.activeExecutions.has(event.sessionID)) {
        ensureRunSpan(event.sessionID, Date.now(), ctx)
        const runContext = ctx.tracing.runSpanContexts.get(event.sessionID)
        if (runContext) injectTraceContext(runContext, event.headers)
      } else {
        const parentID = ctx.tracing.sessionIdentity.get(event.sessionID)?.parentID
        const parentContext = parentID ? ctx.tracing.runSpanContexts.get(parentID) : undefined
        const fallback = parentContext ?? ctx.tracing.runSpanContexts.get(event.sessionID)
        if (fallback) injectTraceContext(fallback, event.headers)
      }
    }
    return
  }
  if (!isTraceEnabled("llm", ctx)) return
  ensureRunSpan(event.sessionID, Date.now(), ctx)
  let active = ctx.tracing.activeLlm.get(event.sessionID)
  if (active) {
    const deadline = Date.now() + ACTIVE_LLM_SETTLE_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, ACTIVE_LLM_SETTLE_TICK_MS))
      await ctx.tracing.eventQueue
      const current = ctx.tracing.activeLlm.get(event.sessionID)
      if (!current || current.spanContext.spanId !== active.spanContext.spanId) {
        active = current
        break
      }
    }
  }
  if (!active) {
    const span = ctx.tracer.startSpan(
      `${ctx.tracePrefix}llm`,
      {
        startTime: Date.now(),
        kind: SpanKind.CLIENT,
        attributes: {
          [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
          [SESSION_ID]: event.sessionID,
          [AGENT_NAME]: event.agent,
          [LLM_MODEL_NAME]: event.model.id,
          [LLM_PROVIDER]: providerID,
          "gen_ai.provider.name": genAiProviderName(providerID),
          ...ctx.commonAttrs,
        },
      },
      resolveRunContext(event.sessionID, ctx),
    )
    setBoundedMap(ctx.tracing.provisionalLlm, event.sessionID, span)
    active = { agent: event.agent, modelID: event.model.id, providerID, spanContext: span.spanContext() }
    setBoundedMap(ctx.tracing.activeLlm, event.sessionID, active)
  }
  if (active.providerID !== providerID || active.modelID !== event.model.id || active.agent !== event.agent) return
  const span = ctx.tracing.provisionalLlm.get(event.sessionID) ?? ctx.tracing.activeStepSpans.get(event.sessionID)
  if (span) applyModelContext(event.sessionID, event.agent, event.model, span, ctx, ctx.tracing.provisionalLlm.has(event.sessionID))
  if (propagate) injectTraceContext(active.spanContext, event.headers)
}
