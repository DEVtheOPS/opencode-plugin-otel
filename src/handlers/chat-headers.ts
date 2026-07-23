import type { ProviderContext } from "@opencode-ai/plugin"
import type { Model, UserMessage } from "@opencode-ai/sdk"
import type { HandlerContext } from "../types.ts"
import { injectTraceContext } from "../trace-context.ts"

/** Injects the matching LLM span context for explicitly enabled providers. */
export function handleChatHeaders(
  input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
  output: { headers: Record<string, string> },
  ctx: HandlerContext,
): void {
  const providerID = input.model.providerID
  if (!ctx.tracePropagationProviders.has(providerID) && !ctx.tracePropagationProviders.has("*")) return

  const request = ctx.llmRequestContexts.get(`${input.sessionID}:${input.message.id}`)?.find(candidate =>
    candidate.agent === input.agent
    && candidate.modelID === input.model.id
    && candidate.providerID === providerID
  )
  if (!request) return

  injectTraceContext(request.spanContext, output.headers)
}
