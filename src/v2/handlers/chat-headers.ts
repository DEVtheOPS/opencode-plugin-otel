import type { HandlerContext } from "../types.ts"
import { injectTraceContext } from "../../trace-context.ts"

/** Injects the matching LLM step span context for explicitly enabled providers. */
export function handleModelRequest(
  event: {
    sessionID: string
    agent: string
    model: { id: string; providerID: string }
    headers: Record<string, string>
  },
  ctx: HandlerContext,
): void {
  const providerID = event.model.providerID
  if (!ctx.tracePropagationProviders.has(providerID) && !ctx.tracePropagationProviders.has("*")) return

  const request = ctx.llmRequestContexts
    .get(event.sessionID)
    ?.findLast(
      (candidate) =>
        candidate.agent === event.agent &&
        candidate.modelID === event.model.id &&
        candidate.providerID === providerID,
    )
  if (!request) return

  injectTraceContext(request.spanContext, event.headers)
}
