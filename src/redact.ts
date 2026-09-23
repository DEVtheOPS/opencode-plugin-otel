// Masks credential-shaped substrings in captured text. Intentionally conservative:
// it targets known token formats and secret-looking key/value pairs, and leaves normal
// prompt/tool text untouched.

const REPLACEMENT = "[REDACTED]"

/** `[pattern, replacement]` pairs applied in order. */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Authorization headers / bearer tokens.
  [/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s"',;]+/gi, `$1${REPLACEMENT}`],
  [/\bbearer\s+[A-Za-z0-9._\-]+/gi, `Bearer ${REPLACEMENT}`],
  // Known token prefixes.
  [/\bsk-[A-Za-z0-9_\-]{16,}\b/g, REPLACEMENT], // OpenAI-style
  [/\bpylf_v\d+_[A-Za-z0-9._\-]+/g, REPLACEMENT], // Logfire
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REPLACEMENT], // GitHub
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REPLACEMENT], // GitHub fine-grained PAT
  [/\bAKIA[0-9A-Z]{16}\b/g, REPLACEMENT], // AWS access key id
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, REPLACEMENT], // Slack
  [/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, REPLACEMENT], // JWT
  // Secret-looking key/value pairs (ENV=..., "password": "...", api_key: ...).
  [
    /([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET)[A-Za-z0-9_]*\s*[:=]\s*)(["']?)([^\s"',;]+)\2/gi,
    `$1$2${REPLACEMENT}$2`,
  ],
]

/** Returns `text` with credential-shaped substrings replaced by `[REDACTED]`. */
export function redactSecrets(text: string, literals: readonly string[] = []): string {
  if (!text) return text
  let out = text
  // Exact known values first (handles opaque tokens with no recognisable shape).
  for (const literal of literals) {
    if (literal && literal.length >= 6) out = out.split(literal).join(REPLACEMENT)
  }
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out
}
