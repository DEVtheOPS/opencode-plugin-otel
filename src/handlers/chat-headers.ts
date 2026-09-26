import { SpanKind } from "@opentelemetry/api"
import { AGENT_NAME, LLM_MODEL_NAME, LLM_PROVIDER, OpenInferenceSpanKind, SemanticConventions, SESSION_ID } from "@arizeai/openinference-semantic-conventions"
import type { HandlerContext } from "../types.ts"
import { injectTraceContext } from "../trace-context.ts"
import { genAiProviderName, isTraceEnabled, resolveRunContext, setBoundedMap } from "../util.ts"

/** The `session.hook("model.request", ...)` event shape consumed by this handler. */
export type ModelRequestEvent = {
  sessionID: string
  agent: string
  model: { providerID: string; id: string }
  kind: string
  headers: Record<string, string>
}

/** Injects the active LLM span's W3C trace context into outbound model requests. */
export async function handleModelRequest(event: ModelRequestEvent, ctx: HandlerContext): Promise<void> {
  if (event.kind !== "primary") return
  const providerID = event.model.providerID
  if (!ctx.tracePropagationProviders.has(providerID) && !ctx.tracePropagationProviders.has("*")) return
  if (!isTraceEnabled("llm", ctx)) return
  await ctx.tracing.eventQueue
  let active = ctx.tracing.activeLlm.get(event.sessionID)
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
  injectTraceContext(active.spanContext, event.headers)
}
