import { describe, expect, test } from "bun:test"
import { getJSDocCoverage, JSDOC_COVERAGE_THRESHOLD } from "../scripts/check-jsdoc-coverage.mjs"

describe("JSDoc coverage baseline", () => {
  test("exported API coverage stays at or above 80%", async () => {
    const result = await getJSDocCoverage()
    expect(result.coverage).toBeGreaterThanOrEqual(JSDOC_COVERAGE_THRESHOLD)
  })
})
