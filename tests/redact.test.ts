import { describe, expect, test } from "bun:test"
import { redactSecrets } from "../src/redact.ts"

describe("redactSecrets", () => {
  test("leaves ordinary text untouched", () => {
    const text = "Refactor the parser and add tests for the new branch."
    expect(redactSecrets(text)).toBe(text)
  })

  test("masks known token prefixes", () => {
    expect(redactSecrets("token sk-abcdefghijklmnop123456")).toBe("token [REDACTED]")
    expect(redactSecrets("pylf_v2_eu_abcdef0123456789")).toBe("[REDACTED]")
    expect(redactSecrets("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")).toBe("[REDACTED]")
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED]")
  })

  test("masks authorization headers and JWTs", () => {
    expect(redactSecrets("Authorization: Bearer abcdef123456")).toBe("Authorization: [REDACTED]")
    expect(
      redactSecrets("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
    ).toBe("[REDACTED]")
  })

  test("masks secret-looking key/value pairs", () => {
    expect(redactSecrets("OPENAI_API_KEY=sk-proj-abcdefghijklmnop")).toBe("OPENAI_API_KEY=[REDACTED]")
    expect(redactSecrets("password: hunter2")).toBe("password: [REDACTED]")
  })

  test("masks exact configured values even without a recognisable shape", () => {
    expect(redactSecrets("my token is XADwrfwe2323ef32r23r2 ok", ["XADwrfwe2323ef32r23r2"])).toBe(
      "my token is [REDACTED] ok",
    )
  })
})
