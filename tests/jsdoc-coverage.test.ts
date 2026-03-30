import { describe, expect, test } from "bun:test"

describe("JSDoc coverage baseline", () => {
  test("exported API coverage stays at or above 80%", async () => {
    const proc = Bun.spawn([process.execPath, "run", "check:jsdoc-coverage"], {
      cwd: "/Users/digitalfiz/Development/github/devtheops/opencode-plugin-otel",
      stdout: "pipe",
      stderr: "pipe",
    })
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    expect(exitCode, stderr).toBe(0)
  })
})
