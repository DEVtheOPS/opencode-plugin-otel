// Minimal local typings for the V2 server event contract consumed by this plugin.
// Shapes are taken from @opencode/schema (v2.0.x) and verified against live payloads.

export type V2Tokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export type V2Error = { type: string; message: string; status?: number }

export type V2Model = { id: string; providerID: string; variant?: string }

export type V2ToolContent = { type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string }

/** A single decoded V2 server event, as yielded by `ctx.event.subscribe()`. */
export type V2Event = {
  id?: string
  type: string
  created: number
  data: Record<string, unknown>
}

/** Total billed tokens for a usage sample (excludes cache reads/writes). */
export function totalTokens(tokens: V2Tokens | undefined): number {
  if (!tokens) return 0
  return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0)
}

/** Formats a V2 model ref as `provider/id`. */
export function modelRef(model: V2Model | undefined): string {
  return model ? `${model.providerID}/${model.id}` : "unknown"
}

/** Human-readable summary of a V2 error payload. */
export function errorSummary(error: V2Error | undefined): string {
  if (!error) return "unknown"
  return `${error.type}: ${error.message}`
}
