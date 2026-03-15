import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { parseEnvInt, loadConfig, resolveLogLevel } from "../src/config.ts"

describe("parseEnvInt", () => {
  test("returns fallback when env var is unset", () => {
    delete process.env["TEST_INT"]
    expect(parseEnvInt("TEST_INT", 42)).toBe(42)
  })

  test("parses a valid positive integer", () => {
    process.env["TEST_INT"] = "1000"
    expect(parseEnvInt("TEST_INT", 42)).toBe(1000)
  })

  test("returns fallback for non-numeric value", () => {
    process.env["TEST_INT"] = "fast"
    expect(parseEnvInt("TEST_INT", 42)).toBe(42)
  })

  test("returns fallback for zero", () => {
    process.env["TEST_INT"] = "0"
    expect(parseEnvInt("TEST_INT", 42)).toBe(42)
  })

  test("returns fallback for negative value", () => {
    process.env["TEST_INT"] = "-5"
    expect(parseEnvInt("TEST_INT", 42)).toBe(42)
  })

  test("returns fallback for float string", () => {
    process.env["TEST_INT"] = "1.5"
    expect(parseEnvInt("TEST_INT", 42)).toBe(42)
  })

  test("returns fallback for partial numeric string", () => {
    process.env["TEST_INT"] = "5000ms"
    expect(parseEnvInt("TEST_INT", 42)).toBe(42)
  })

  afterEach(() => { delete process.env["TEST_INT"] })
})

describe("loadConfig", () => {
  const vars = [
    "OPENCODE_ENABLE_TELEMETRY",
    "OPENCODE_OTLP_ENDPOINT",
    "OPENCODE_OTLP_METRICS_INTERVAL",
    "OPENCODE_OTLP_LOGS_INTERVAL",
    "OPENCODE_OTLP_HEADERS",
    "OPENCODE_RESOURCE_ATTRIBUTES",
    "OPENCODE_DISABLE_METRICS",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_RESOURCE_ATTRIBUTES",
  ]
  beforeEach(() => vars.forEach((k) => delete process.env[k]))
  afterEach(() => vars.forEach((k) => delete process.env[k]))

  test("defaults when no env vars set", () => {
    const cfg = loadConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.endpoint).toBe("http://localhost:4317")
    expect(cfg.metricsInterval).toBe(60000)
    expect(cfg.logsInterval).toBe(5000)
  })

  test("enabled when OPENCODE_ENABLE_TELEMETRY is set", () => {
    process.env["OPENCODE_ENABLE_TELEMETRY"] = "1"
    expect(loadConfig().enabled).toBe(true)
  })

  test("reads custom endpoint", () => {
    process.env["OPENCODE_OTLP_ENDPOINT"] = "http://collector:4317"
    expect(loadConfig().endpoint).toBe("http://collector:4317")
  })

  test("reads custom intervals", () => {
    process.env["OPENCODE_OTLP_METRICS_INTERVAL"] = "30000"
    process.env["OPENCODE_OTLP_LOGS_INTERVAL"] = "2000"
    const cfg = loadConfig()
    expect(cfg.metricsInterval).toBe(30000)
    expect(cfg.logsInterval).toBe(2000)
  })

  test("falls back to defaults for invalid interval values", () => {
    process.env["OPENCODE_OTLP_METRICS_INTERVAL"] = "notanumber"
    process.env["OPENCODE_OTLP_LOGS_INTERVAL"] = "0"
    const cfg = loadConfig()
    expect(cfg.metricsInterval).toBe(60000)
    expect(cfg.logsInterval).toBe(5000)
  })

  test("copies OPENCODE_OTLP_HEADERS to OTEL_EXPORTER_OTLP_HEADERS", () => {
    process.env["OPENCODE_OTLP_HEADERS"] = "api-key=abc123"
    loadConfig()
    expect(process.env["OTEL_EXPORTER_OTLP_HEADERS"]).toBe("api-key=abc123")
  })

  test("copies OPENCODE_RESOURCE_ATTRIBUTES to OTEL_RESOURCE_ATTRIBUTES", () => {
    process.env["OPENCODE_RESOURCE_ATTRIBUTES"] = "team=platform,env=prod"
    loadConfig()
    expect(process.env["OTEL_RESOURCE_ATTRIBUTES"]).toBe("team=platform,env=prod")
  })

  test("does not set OTEL_EXPORTER_OTLP_HEADERS when OPENCODE_OTLP_HEADERS is unset", () => {
    delete process.env["OPENCODE_OTLP_HEADERS"]
    loadConfig()
    expect(process.env["OTEL_EXPORTER_OTLP_HEADERS"]).toBeUndefined()
  })

  test("does not overwrite pre-existing OTEL_* vars when OPENCODE_* vars are unset", () => {
    process.env["OTEL_EXPORTER_OTLP_HEADERS"] = "existing-header=value"
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "existing=attr"
    loadConfig()
    expect(process.env["OTEL_EXPORTER_OTLP_HEADERS"]).toBe("existing-header=value")
    expect(process.env["OTEL_RESOURCE_ATTRIBUTES"]).toBe("existing=attr")
  })

  test("OPENCODE_OTLP_HEADERS overwrites pre-existing OTEL_EXPORTER_OTLP_HEADERS", () => {
    process.env["OTEL_EXPORTER_OTLP_HEADERS"] = "old-header=old"
    process.env["OPENCODE_OTLP_HEADERS"] = "new-header=new"
    loadConfig()
    expect(process.env["OTEL_EXPORTER_OTLP_HEADERS"]).toBe("new-header=new")
  })

  test("OPENCODE_RESOURCE_ATTRIBUTES overwrites pre-existing OTEL_RESOURCE_ATTRIBUTES", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "old=attr"
    process.env["OPENCODE_RESOURCE_ATTRIBUTES"] = "new=attr"
    loadConfig()
    expect(process.env["OTEL_RESOURCE_ATTRIBUTES"]).toBe("new=attr")
  })

  test("disabledMetrics is empty set when OPENCODE_DISABLE_METRICS is unset", () => {
    expect(loadConfig().disabledMetrics.size).toBe(0)
  })

  test("disabledMetrics parses a single metric name", () => {
    process.env["OPENCODE_DISABLE_METRICS"] = "session.count"
    expect(loadConfig().disabledMetrics).toEqual(new Set(["session.count"]))
  })

  test("disabledMetrics parses a comma-separated list", () => {
    process.env["OPENCODE_DISABLE_METRICS"] = "session.count,cache.count,retry.count"
    const { disabledMetrics } = loadConfig()
    expect(disabledMetrics.has("session.count")).toBe(true)
    expect(disabledMetrics.has("cache.count")).toBe(true)
    expect(disabledMetrics.has("retry.count")).toBe(true)
  })

  test("disabledMetrics trims whitespace around names", () => {
    process.env["OPENCODE_DISABLE_METRICS"] = " session.count , cache.count "
    const { disabledMetrics } = loadConfig()
    expect(disabledMetrics.has("session.count")).toBe(true)
    expect(disabledMetrics.has("cache.count")).toBe(true)
  })

  test("disabledMetrics ignores empty segments from trailing commas", () => {
    process.env["OPENCODE_DISABLE_METRICS"] = "session.count,"
    expect(loadConfig().disabledMetrics.size).toBe(1)
  })
})

describe("resolveLogLevel", () => {
  test("resolves known level (uppercase input)", () => {
    expect(resolveLogLevel("DEBUG", "info")).toBe("debug")
    expect(resolveLogLevel("WARN", "info")).toBe("warn")
    expect(resolveLogLevel("ERROR", "info")).toBe("error")
  })

  test("resolves known level (lowercase input)", () => {
    expect(resolveLogLevel("debug", "info")).toBe("debug")
  })

  test("returns current level for unknown value", () => {
    expect(resolveLogLevel("verbose", "info")).toBe("info")
    expect(resolveLogLevel("", "warn")).toBe("warn")
  })
})
