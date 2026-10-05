import { beforeAll, describe, expect, test } from "bun:test"
import { runScenario } from "./fixtures.ts"
import { attributes, metricPoints, objects, signalRecords } from "./otlp.ts"

test("exports real OpenCode session telemetry over OTLP/JSON", async () => {
  const { received, requests, result } = await runScenario("text")
  expect(requests).toHaveLength(1)
  expect(result["sessionID"]).toBeString()
  expect(received["traces"]!.length).toBeGreaterThan(0)
  expect(received["metrics"]!.length).toBeGreaterThan(0)
  expect(received["logs"]!.length).toBeGreaterThan(0)

  const spans = signalRecords(received["traces"]!, "Spans")
  const run = spans.find(span => span["name"] === "opencode.session")!
  const llm = spans.find(span => span["name"] === "opencode.llm")!
  expect(attributes(run)["session.id"]).toBe(result["sessionID"])
  expect(llm["traceId"]).toBe(run["traceId"])
  expect(llm["parentSpanId"]).toBe(run["spanId"])
  expect(attributes(llm)["llm.token_count.prompt"]).toBe(20)
  expect(attributes(llm)["llm.token_count.completion"]).toBe(5)

  const metrics = signalRecords(received["metrics"]!, "Metrics")
  const sessions = metricPoints(metrics, "opencode.session.count", "sum").at(-1)!
  expect(Number(sessions["asDouble"] ?? sessions["asInt"])).toBe(1)
  expect(attributes(sessions)["session.id"]).toBe(result["sessionID"])
  const logs = signalRecords(received["logs"]!, "Logs")
  expect(logs.some(log => attributes(log)["event.name"] === "api_request")).toBe(true)
  expect(logs.some(log => attributes(log)["event.name"] === "session.idle")).toBe(true)
}, 40_000)

for (const disabled of [false, true]) {
  describe(`local read with tool tracing ${disabled ? "disabled" : "enabled"}`, () => {
    let scenario: Awaited<ReturnType<typeof runScenario>>
    beforeAll(async () => { scenario = await runScenario("read", disabled ? "tool" : "") }, 40_000)

    test("executes the real read tool and reports its contents to the provider", () => {
      expect(scenario.requests).toHaveLength(2)
      const messages = objects(scenario.requests[1]!["messages"])
      const result = messages.find(message => message["role"] === "tool")!
      expect(result["tool_call_id"]).toBe("call_read")
      expect(result["content"]).toContain("integration-fixture-contents")
      const tool = objects(scenario.result["messages"])
        .flatMap(message => objects(message["content"])).find(part => part["type"] === "tool")!
      expect(tool["executed"]).toBe(false)
      const logs = signalRecords(scenario.received["logs"]!, "Logs")
      const log = logs.find(record => attributes(record)["event.name"] === "tool_result")!
      expect(attributes(log)["tool_name"]).toBe("read")
      expect(attributes(log)["success"]).toBe(true)
    })

    if (disabled) {
      test("does not export tool spans", () => {
        expect(signalRecords(scenario.received["traces"]!, "Spans")
          .some(span => String(span["name"]).startsWith("opencode.tool."))).toBe(false)
      })
    } else {
      test.failing("#134: exports a locally executed tool span under its LLM span", () => {
        const spans = signalRecords(scenario.received["traces"]!, "Spans")
        const tool = spans.find(span => span["name"] === "opencode.tool.read")
        expect(tool).toBeDefined()
        const parent = spans.find(span => span["spanId"] === tool!["parentSpanId"])!
        expect(parent["name"]).toBe("opencode.llm")
        expect(tool!["traceId"]).toBe(parent["traceId"])
        expect(attributes(tool!)["output.value"]).toContain("integration-fixture-contents")
      })
    }

    test.failing("#134: exports a duration sample for the locally executed tool", () => {
      const metrics = signalRecords(scenario.received["metrics"]!, "Metrics")
      const points = metricPoints(metrics, "opencode.tool.duration", "histogram")
        .filter(point => attributes(point)["tool_name"] === "read")
      expect(points.length).toBeGreaterThan(0)
      expect(Number(points.at(-1)!["count"])).toBe(1)
      expect(attributes(points.at(-1)!)["success"]).toBe(true)
      const logs = signalRecords(scenario.received["logs"]!, "Logs")
      const log = logs.find(record => attributes(record)["event.name"] === "tool_result")!
      expect(Number(points.at(-1)!["sum"])).toBe(Number(attributes(log)["duration_ms"]))
    })
  })
}
