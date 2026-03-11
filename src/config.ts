import { LEVELS, type Level } from "./types.ts"

/** Configuration values resolved from `OPENCODE_*` environment variables. */
export type PluginConfig = {
  enabled: boolean
  endpoint: string
  metricsInterval: number
  logsInterval: number
  metricPrefix: string
  otlpHeaders: string | undefined
  resourceAttributes: string | undefined
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
 * Copies `OPENCODE_OTLP_HEADERS` → `OTEL_EXPORTER_OTLP_HEADERS` and
 * `OPENCODE_RESOURCE_ATTRIBUTES` → `OTEL_RESOURCE_ATTRIBUTES` so the OTel SDK
 * picks them up automatically when initialised.
 */
export function loadConfig(): PluginConfig {
  const otlpHeaders = process.env["OPENCODE_OTLP_HEADERS"]
  const resourceAttributes = process.env["OPENCODE_RESOURCE_ATTRIBUTES"]

  if (otlpHeaders) process.env["OTEL_EXPORTER_OTLP_HEADERS"] = otlpHeaders
  if (resourceAttributes) process.env["OTEL_RESOURCE_ATTRIBUTES"] = resourceAttributes

  return {
    enabled: !!process.env["OPENCODE_ENABLE_TELEMETRY"],
    endpoint: process.env["OPENCODE_OTLP_ENDPOINT"] ?? "http://localhost:4317",
    metricsInterval: parseEnvInt("OPENCODE_OTLP_METRICS_INTERVAL", 60000),
    logsInterval: parseEnvInt("OPENCODE_OTLP_LOGS_INTERVAL", 5000),
    metricPrefix: process.env["OPENCODE_METRIC_PREFIX"] ?? "opencode.",
    otlpHeaders,
    resourceAttributes,
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
