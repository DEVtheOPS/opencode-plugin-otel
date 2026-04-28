import { LEVELS, type Level } from "./types.ts"

/** Accepted values for `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`. */
export type MetricsTemporality = "cumulative" | "delta" | "lowmemory"

const VALID_TEMPORALITIES: ReadonlySet<MetricsTemporality> = new Set<MetricsTemporality>(["cumulative", "delta", "lowmemory"])

/** Configuration values resolved from `OPENCODE_*` environment variables. */
export type PluginConfig = {
  enabled: boolean
  endpoint: string
  protocol: "grpc" | "http/protobuf"
  metricsInterval: number
  logsInterval: number
  metricPrefix: string
  otlpHeaders: string | undefined
  resourceAttributes: string | undefined
  metricsTemporality: MetricsTemporality | undefined
  disabledMetrics: Set<string>
  disabledTraces: Set<string>
}

/** Parses a positive integer from an environment variable, returning `fallback` if absent or invalid. */
export function parseEnvInt(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  if (!/^[1-9]\d*$/.test(raw)) return fallback
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : fallback
}

/**
 * Reads all `OPENCODE_*` environment variables and returns the resolved plugin config.
 * Copies `OPENCODE_OTLP_HEADERS` → `OTEL_EXPORTER_OTLP_HEADERS`,
 * `OPENCODE_RESOURCE_ATTRIBUTES` → `OTEL_RESOURCE_ATTRIBUTES`, and
 * `OPENCODE_OTLP_METRICS_TEMPORALITY` → `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`
 * so the OTel SDK picks them up automatically when initialised.
 */
export function loadConfig(): PluginConfig {
  const otlpHeaders = process.env["OPENCODE_OTLP_HEADERS"]
  const resourceAttributes = process.env["OPENCODE_RESOURCE_ATTRIBUTES"]
  const rawTemporality = process.env["OPENCODE_OTLP_METRICS_TEMPORALITY"]
  const protocol = process.env["OPENCODE_OTLP_PROTOCOL"]

  let metricsTemporality: MetricsTemporality | undefined
  if (rawTemporality) {
    const normalized = rawTemporality.toLowerCase()
    if (VALID_TEMPORALITIES.has(normalized as MetricsTemporality)) {
      metricsTemporality = normalized as MetricsTemporality
      process.env["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"] = normalized
    } else {
      console.warn(
        `[opencode-plugin-otel] Invalid OPENCODE_OTLP_METRICS_TEMPORALITY="${rawTemporality}". ` +
          `Expected one of: cumulative, delta, lowmemory. Value ignored.`,
      )
    }
  }

  if (otlpHeaders) process.env["OTEL_EXPORTER_OTLP_HEADERS"] = otlpHeaders
  if (resourceAttributes) process.env["OTEL_RESOURCE_ATTRIBUTES"] = resourceAttributes

  const disabledMetrics = new Set(
    (process.env["OPENCODE_DISABLE_METRICS"] ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean),
  )

  const disabledTraces = new Set(
    (process.env["OPENCODE_DISABLE_TRACES"] ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean),
  )

  return {
    enabled: !!process.env["OPENCODE_ENABLE_TELEMETRY"],
    endpoint: process.env["OPENCODE_OTLP_ENDPOINT"] ?? "http://localhost:4317",
    protocol: protocol === "http/protobuf" ? "http/protobuf" : "grpc",
    metricsInterval: parseEnvInt("OPENCODE_OTLP_METRICS_INTERVAL", 60000),
    logsInterval: parseEnvInt("OPENCODE_OTLP_LOGS_INTERVAL", 5000),
    metricPrefix: process.env["OPENCODE_METRIC_PREFIX"] ?? "opencode.",
    otlpHeaders,
    resourceAttributes,
    metricsTemporality,
    disabledMetrics,
    disabledTraces,
  }
}

/**
 * Resolves an opencode log level string to a `Level`.
 * Returns `current` unchanged when the input does not match a known level.
 */
export function resolveLogLevel(logLevel: string, current: Level): Level {
  const candidate = logLevel.toLowerCase()
  if (candidate in LEVELS) return candidate as Level
  return current
}
