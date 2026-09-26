import type { HandlerContext } from "../types.ts"
import { injectTraceContext } from "../trace-context.ts"

/** The `session.hook("model.request", ...)` event shape consumed by this handler. */
export type ModelRequestEvent = {
  sessionID: string
  agent: string
  model: { providerID: string; id: string }
  kind: string
  headers: Record<string, string>
}

/** Injects the active LLM span's W3C trace context into outbound model requests. */
export function handleModelRequest(event: ModelRequestEvent, ctx: HandlerContext): void {
  const providerID = event.model.providerID
  if (!ctx.tracePropagationProviders.has(providerID) && !ctx.tracePropagationProviders.has("*")) return
  const active = ctx.tracing.activeLlm.get(event.sessionID)
  if (!active || active.providerID !== providerID) return
  injectTraceContext(active.spanContext, event.headers)
}
