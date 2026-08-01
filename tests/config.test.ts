import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { parseAttributePairs, parseEnvInt, loadConfig, resolveHelperPath, resolveLogLevel, TRACE_TYPES } from "../src/config.ts"

describe("parseAttributePairs", () => {
  test("parses comma-separated key=value pairs", () => {
    expect(parseAttributePairs("team=platform,env=prod")).toEqual({ team: "platform", env: "prod" })
  })

  test("trims whitespace and keeps empty values", () => {
    expect(parseAttributePairs(" team = platform , empty = ")).toEqual({ team: "platform", empty: "" })
  })

  test("uses only the first equals sign as the separator", () => {
    expect(parseAttributePairs("auth=Bearer abc=123")).toEqual({ auth: "Bearer abc=123" })
  })

  test("ignores malformed pairs", () => {
    expect(parseAttributePairs("missingequals,=novalue,,valid=yes")).toEqual({ valid: "yes" })
  })
})

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
    "OPENCODE_OTLP_PROTOCOL",
    "OPENCODE_OTLP_METRICS_INTERVAL",
    "OPENCODE_OTLP_LOGS_INTERVAL",
    "OPENCODE_OTLP_HEADERS",
    "OPENCODE_OTLP_HEADERS_HELPER",
    "OPENCODE_RESOURCE_ATTRIBUTES",
    "OPENCODE_SPAN_ATTRIBUTES",
    "OPENCODE_TRACEPARENT",
    "OPENCODE_TRACESTATE",
    "OPENCODE_OTLP_METRICS_TEMPORALITY",
    "OPENCODE_DISABLE_METRICS",
    "OPENCODE_DISABLE_LOGS",
    "OPENCODE_CAPTURE_PROMPT_IN_LOGS",
    "OPENCODE_DISABLE_TRACES",
    "OPENCODE_TRACE_PROPAGATION_PROVIDERS",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE",
  ]
  beforeEach(() => vars.forEach((k) => delete process.env[k]))
  afterEach(() => vars.forEach((k) => delete process.env[k]))

  test("defaults when no env vars set", () => {
    const cfg = loadConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.logsEnabled).toBe(true)
    expect(cfg.capturePromptInLogs).toBe(false)
    expect(cfg.endpoint).toBe("http://localhost:4317")
    expect(cfg.protocol).toBe("grpc")
    expect(cfg.metricsInterval).toBe(60000)
    expect(cfg.logsInterval).toBe(5000)
  })

  test("enabled when OPENCODE_ENABLE_TELEMETRY is set", () => {
    process.env["OPENCODE_ENABLE_TELEMETRY"] = "1"
    expect(loadConfig().enabled).toBe(true)
  })

  test("logsEnabled is false when OPENCODE_DISABLE_LOGS is set", () => {
    process.env["OPENCODE_DISABLE_LOGS"] = "1"
    expect(loadConfig().logsEnabled).toBe(false)
  })

  test("capturePromptInLogs is true when OPENCODE_CAPTURE_PROMPT_IN_LOGS is set", () => {
    process.env["OPENCODE_CAPTURE_PROMPT_IN_LOGS"] = "1"
    expect(loadConfig().capturePromptInLogs).toBe(true)
  })

  test("reads custom endpoint", () => {
    process.env["OPENCODE_OTLP_ENDPOINT"] = "http://collector:4317"
    expect(loadConfig().endpoint).toBe("http://collector:4317")
  })

  test("reads HTTP/protobuf protocol", () => {
    process.env["OPENCODE_OTLP_PROTOCOL"] = "http/protobuf"
    expect(loadConfig().protocol).toBe("http/protobuf")
  })

  test("reads HTTP/json protocol", () => {
    process.env["OPENCODE_OTLP_PROTOCOL"] = "http/json"
    expect(loadConfig().protocol).toBe("http/json")
  })

  test("falls back to grpc for unknown protocol", () => {
    process.env["OPENCODE_OTLP_PROTOCOL"] = "http"
    expect(loadConfig().protocol).toBe("grpc")
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

  test("reads OPENCODE_OTLP_HEADERS_HELPER", () => {
    process.env["OPENCODE_OTLP_HEADERS_HELPER"] = "/tmp/otel-headers"
    expect(loadConfig().otlpHeadersHelper).toBe("/tmp/otel-headers")
  })

  test("copies OPENCODE_RESOURCE_ATTRIBUTES to OTEL_RESOURCE_ATTRIBUTES", () => {
    process.env["OPENCODE_RESOURCE_ATTRIBUTES"] = "team=platform,env=prod"
    loadConfig()
    expect(process.env["OTEL_RESOURCE_ATTRIBUTES"]).toBe("team=platform,env=prod")
  })

  test("reads OPENCODE trace context", () => {
    process.env["OPENCODE_TRACEPARENT"] = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
    process.env["OPENCODE_TRACESTATE"] = "vendor=value"
    const cfg = loadConfig()
    expect(cfg.traceparent).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
    expect(cfg.tracestate).toBe("vendor=value")
  })

  test("reads OPENCODE_SPAN_ATTRIBUTES", () => {
    process.env["OPENCODE_SPAN_ATTRIBUTES"] = "team=platform,env=prod"
    expect(loadConfig().spanAttributes).toBe("team=platform,env=prod")
  })

  test("does not set OTEL_EXPORTER_OTLP_HEADERS when OPENCODE_OTLP_HEADERS is unset", () => {
    delete process.env["OPENCODE_OTLP_HEADERS"]
    loadConfig()
    expect(process.env["OTEL_EXPORTER_OTLP_HEADERS"]).toBeUndefined()
  })

  test("copies OPENCODE_OTLP_METRICS_TEMPORALITY to OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE", () => {
    process.env["OPENCODE_OTLP_METRICS_TEMPORALITY"] = "delta"
    const cfg = loadConfig()
    expect(process.env["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"]).toBe("delta")
    expect(cfg.metricsTemporality).toBe("delta")
  })

  test("does not set OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE when OPENCODE_OTLP_METRICS_TEMPORALITY is unset", () => {
    delete process.env["OPENCODE_OTLP_METRICS_TEMPORALITY"]
    const cfg = loadConfig()
    expect(process.env["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"]).toBeUndefined()
    expect(cfg.metricsTemporality).toBeUndefined()
  })

  test("normalizes OPENCODE_OTLP_METRICS_TEMPORALITY to lowercase", () => {
    process.env["OPENCODE_OTLP_METRICS_TEMPORALITY"] = "Delta"
    const cfg = loadConfig()
    expect(process.env["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"]).toBe("delta")
    expect(cfg.metricsTemporality).toBe("delta")
  })

  test("ignores invalid OPENCODE_OTLP_METRICS_TEMPORALITY and warns", () => {
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(String(args[0]))
    try {
      process.env["OPENCODE_OTLP_METRICS_TEMPORALITY"] = "bogus"
      const cfg = loadConfig()
      expect(process.env["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"]).toBeUndefined()
      expect(cfg.metricsTemporality).toBeUndefined()
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toContain("bogus")
    } finally {
      console.warn = origWarn
    }
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

  test("disabledTraces is empty set when OPENCODE_DISABLE_TRACES is unset", () => {
    expect(loadConfig().disabledTraces.size).toBe(0)
  })

  test("disabledTraces parses a single trace type", () => {
    process.env["OPENCODE_DISABLE_TRACES"] = "session"
    expect(loadConfig().disabledTraces).toEqual(new Set(["session"]))
  })

  test("disabledTraces parses a comma-separated list", () => {
    process.env["OPENCODE_DISABLE_TRACES"] = "llm,tool"
    const { disabledTraces } = loadConfig()
    expect(disabledTraces.has("llm")).toBe(true)
    expect(disabledTraces.has("tool")).toBe(true)
  })

  test("disabledTraces parses all three types together", () => {
    process.env["OPENCODE_DISABLE_TRACES"] = "session,llm,tool"
    const { disabledTraces } = loadConfig()
    expect(disabledTraces.has("session")).toBe(true)
    expect(disabledTraces.has("llm")).toBe(true)
    expect(disabledTraces.has("tool")).toBe(true)
  })

  test("disabledTraces trims whitespace around names", () => {
    process.env["OPENCODE_DISABLE_TRACES"] = " llm , tool "
    const { disabledTraces } = loadConfig()
    expect(disabledTraces.has("llm")).toBe(true)
    expect(disabledTraces.has("tool")).toBe(true)
  })

  test("disabledTraces ignores empty segments from trailing commas", () => {
    process.env["OPENCODE_DISABLE_TRACES"] = "session,"
    expect(loadConfig().disabledTraces.size).toBe(1)
  })

  test("disabledTraces passes unknown values through silently", () => {
    process.env["OPENCODE_DISABLE_TRACES"] = "session,unknown_type"
    const { disabledTraces } = loadConfig()
    expect(disabledTraces.has("session")).toBe(true)
    expect(disabledTraces.has("unknown_type")).toBe(true)
    expect(disabledTraces.size).toBe(2)
  })

  test("disabledTraces expands all to every known trace type", () => {
    process.env["OPENCODE_DISABLE_TRACES"] = "all"
    expect(loadConfig().disabledTraces).toEqual(new Set(TRACE_TYPES))
  })

  test("disabledTraces expands wildcard to every known trace type", () => {
    process.env["OPENCODE_DISABLE_TRACES"] = "*"
    expect(loadConfig().disabledTraces).toEqual(new Set(TRACE_TYPES))
  })

  test("disabledTraces expands boolean-style values to every known trace type", () => {
    process.env["OPENCODE_DISABLE_TRACES"] = "true"
    expect(loadConfig().disabledTraces).toEqual(new Set(TRACE_TYPES))
  })

  test('disabledTraces expands numeric-style value "1" to every known trace type', () => {
    process.env["OPENCODE_DISABLE_TRACES"] = "1"
    expect(loadConfig().disabledTraces).toEqual(new Set(TRACE_TYPES))
  })

  test("tracePropagationProviders is empty when unset", () => {
    expect(loadConfig().tracePropagationProviders).toEqual(new Set())
  })

  test("parses trace propagation providers", () => {
    process.env["OPENCODE_TRACE_PROPAGATION_PROVIDERS"] = " company-litellm , vllm "
    expect(loadConfig().tracePropagationProviders).toEqual(new Set(["company-litellm", "vllm"]))
  })
})

describe("loadConfig options", () => {
  const vars = [
    "OPENCODE_ENABLE_TELEMETRY",
    "OPENCODE_OTLP_ENDPOINT",
    "OPENCODE_OTLP_PROTOCOL",
    "OPENCODE_OTLP_METRICS_INTERVAL",
    "OPENCODE_OTLP_LOGS_INTERVAL",
    "OPENCODE_METRIC_PREFIX",
    "OPENCODE_OTLP_HEADERS",
    "OPENCODE_RESOURCE_ATTRIBUTES",
    "OPENCODE_OTLP_METRICS_TEMPORALITY",
    "OPENCODE_DISABLE_METRICS",
    "OPENCODE_DISABLE_LOGS",
    "OPENCODE_DISABLE_TRACES",
    "OPENCODE_TRACE_PROPAGATION_PROVIDERS",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_RESOURCE_ATTRIBUTES",
    "OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE",
  ]
  beforeEach(() => vars.forEach((k) => delete process.env[k]))
  afterEach(() => vars.forEach((k) => delete process.env[k]))

  test("enabled via option without any env var", () => {
    expect(loadConfig({ enabled: true }).enabled).toBe(true)
  })

  test("option enabled:false overrides an enabling env var", () => {
    process.env["OPENCODE_ENABLE_TELEMETRY"] = "1"
    expect(loadConfig({ enabled: false }).enabled).toBe(false)
  })

  test("option logsEnabled:false disables logs", () => {
    expect(loadConfig({ logsEnabled: false }).logsEnabled).toBe(false)
  })

  test("option endpoint overrides env var", () => {
    process.env["OPENCODE_OTLP_ENDPOINT"] = "http://from-env:4317"
    expect(loadConfig({ endpoint: "http://from-option:4317" }).endpoint).toBe("http://from-option:4317")
  })

  test("env endpoint used when option is absent", () => {
    process.env["OPENCODE_OTLP_ENDPOINT"] = "http://from-env:4317"
    expect(loadConfig({ metricPrefix: "x." }).endpoint).toBe("http://from-env:4317")
  })

  test("option protocol overrides env var", () => {
    process.env["OPENCODE_OTLP_PROTOCOL"] = "grpc"
    expect(loadConfig({ protocol: "http/protobuf" }).protocol).toBe("http/protobuf")
  })

  test("option intervals override env vars", () => {
    process.env["OPENCODE_OTLP_METRICS_INTERVAL"] = "30000"
    const cfg = loadConfig({ metricsInterval: 15000, logsInterval: 2500 })
    expect(cfg.metricsInterval).toBe(15000)
    expect(cfg.logsInterval).toBe(2500)
  })

  test("invalid option interval falls back to env then default", () => {
    process.env["OPENCODE_OTLP_METRICS_INTERVAL"] = "45000"
    const cfg = loadConfig({ metricsInterval: 0, logsInterval: -1 })
    expect(cfg.metricsInterval).toBe(45000)
    expect(cfg.logsInterval).toBe(5000)
  })

  test("non-number option interval is ignored", () => {
    const cfg = loadConfig({ metricsInterval: "soon" } as unknown as Parameters<typeof loadConfig>[0])
    expect(cfg.metricsInterval).toBe(60000)
  })

  test("null options are handled safely", () => {
    expect(() => loadConfig(null as unknown as Parameters<typeof loadConfig>[0])).not.toThrow()
    expect(loadConfig(null as unknown as Parameters<typeof loadConfig>[0]).endpoint).toBe("http://localhost:4317")
  })

  test("option metricPrefix overrides env var", () => {
    process.env["OPENCODE_METRIC_PREFIX"] = "env."
    expect(loadConfig({ metricPrefix: "claude_code." }).metricPrefix).toBe("claude_code.")
  })

  test("option otlpHeaders is copied to OTEL_EXPORTER_OTLP_HEADERS", () => {
    const cfg = loadConfig({ otlpHeaders: "api-key=opt" })
    expect(cfg.otlpHeaders).toBe("api-key=opt")
    expect(process.env["OTEL_EXPORTER_OTLP_HEADERS"]).toBe("api-key=opt")
  })

  test("option resourceAttributes is copied to OTEL_RESOURCE_ATTRIBUTES", () => {
    const cfg = loadConfig({ resourceAttributes: "team=platform" })
    expect(cfg.resourceAttributes).toBe("team=platform")
    expect(process.env["OTEL_RESOURCE_ATTRIBUTES"]).toBe("team=platform")
  })

  test("option metricsTemporality is normalized and copied to OTEL preference", () => {
    const cfg = loadConfig({ metricsTemporality: "delta" })
    expect(cfg.metricsTemporality).toBe("delta")
    expect(process.env["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"]).toBe("delta")
  })

  test("invalid protocol option falls back to env then default", () => {
    process.env["OPENCODE_OTLP_PROTOCOL"] = "http/json"
    expect(loadConfig({ protocol: "ftp" as never }).protocol).toBe("http/json")
    delete process.env["OPENCODE_OTLP_PROTOCOL"]
    expect(loadConfig({ protocol: "ftp" as never }).protocol).toBe("grpc")
  })

  test("invalid metricsTemporality option falls back to env then default", () => {
    process.env["OPENCODE_OTLP_METRICS_TEMPORALITY"] = "lowmemory"
    expect(loadConfig({ metricsTemporality: "weekly" as never }).metricsTemporality).toBe("lowmemory")
    delete process.env["OPENCODE_OTLP_METRICS_TEMPORALITY"]
    expect(loadConfig({ metricsTemporality: "weekly" as never }).metricsTemporality).toBeUndefined()
  })

  test("option disabledMetrics array overrides env var", () => {
    process.env["OPENCODE_DISABLE_METRICS"] = "session.count"
    const { disabledMetrics } = loadConfig({ disabledMetrics: ["cache.count", "retry.count"] })
    expect(disabledMetrics).toEqual(new Set(["cache.count", "retry.count"]))
  })

  test("option disabledTraces array expands all to every trace type", () => {
    expect(loadConfig({ disabledTraces: ["all"] }).disabledTraces).toEqual(new Set(TRACE_TYPES))
  })

  test("option disabledTraces array trims and lowercases entries", () => {
    const { disabledTraces } = loadConfig({ disabledTraces: [" LLM ", "Tool"] })
    expect(disabledTraces).toEqual(new Set(["llm", "tool"]))
  })

  test("option tracePropagationProviders overrides the env var", () => {
    process.env["OPENCODE_TRACE_PROPAGATION_PROVIDERS"] = "env-provider"
    const { tracePropagationProviders } = loadConfig({
      tracePropagationProviders: [" company-litellm ", "vllm"],
    })
    expect(tracePropagationProviders).toEqual(new Set(["company-litellm", "vllm"]))
  })

  test("env values still apply when no options are passed", () => {
    process.env["OPENCODE_ENABLE_TELEMETRY"] = "1"
    process.env["OPENCODE_OTLP_ENDPOINT"] = "http://env:4317"
    const cfg = loadConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.endpoint).toBe("http://env:4317")
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

describe("resolveHelperPath", () => {
  test("returns undefined when helper is unset", () => {
    expect(resolveHelperPath(undefined, "/repo/current", "/repo")).toBeUndefined()
  })

  test("expands project placeholders", () => {
    expect(resolveHelperPath("${PROJECT_ROOT}/bin/helper.sh", "/repo/current", "/repo")).toBe("/repo/bin/helper.sh")
    expect(resolveHelperPath("${WORKTREE}/bin/helper.sh", "/repo/current", "/repo")).toBe("/repo/bin/helper.sh")
    expect(resolveHelperPath("${DIRECTORY}/bin/helper.sh", "/repo/current", "/repo")).toBe("/repo/current/bin/helper.sh")
  })

  test("falls back to directory when worktree is unavailable", () => {
    expect(resolveHelperPath("${PROJECT_ROOT}/bin/helper.sh", "/repo/current", undefined)).toBe("/repo/current/bin/helper.sh")
  })
})
