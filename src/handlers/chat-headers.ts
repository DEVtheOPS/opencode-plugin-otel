import type { ProviderContext } from "@opencode-ai/plugin"
import type { Model, UserMessage } from "@opencode-ai/sdk"
import type { HandlerContext } from "../types.ts"

/**
 * Resolves the URL an LLM request will be sent to.
 *
 * Mirrors opencode's own resolution: a non-empty `baseURL` override from the
 * user's provider config wins, otherwise the provider's default `model.api.url`
 * is used.
 */
export function getResolvedURL(provider: ProviderContext, model: Model): string {
  const baseURL = provider.options?.["baseURL"]
  if (typeof baseURL === "string" && baseURL !== "") return baseURL
  return model.api?.url ?? ""
}

/**
 * Returns `true` when `resolvedURL`'s hostname matches one of `allowed`.
 *
 * An empty `allowed` list matches everything. An unparseable URL matches
 * nothing, so a configured allowlist fails closed.
 */
export function matchesEndpoint(resolvedURL: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true
  try {
    const host = new URL(resolvedURL).hostname
    return allowed.some((ep) => {
      try {
        return new URL(ep).hostname === host
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

/** Injects the configured outbound headers into an LLM request whose endpoint is in scope. */
export function handleChatHeaders(
  input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
  output: { headers: Record<string, string> },
  ctx: HandlerContext,
): void {
  const resolvedURL = getResolvedURL(input.provider, input.model)
  if (!matchesEndpoint(resolvedURL, ctx.outboundEndpoints)) return
  for (const [key, value] of Object.entries(ctx.outboundHeaders)) {
    output.headers[key] = value
  }
}
