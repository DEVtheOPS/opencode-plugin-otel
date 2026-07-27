import { LEVELS, type Level } from "./types.ts"

/** Accepted values for `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE`. */
export type MetricsTemporality = "cumulative" | "delta" | "lowmemory"

/** Valid trace types emitted by the plugin. */
export const TRACE_TYPES = ["session", "llm", "tool"] as const

const VALID_TEMPORALITIES: ReadonlySet<MetricsTemporality> = new Set<MetricsTemporality>(["cumulative", "delta", "lowmemory"])
const TRACE_DISABLE_ALL_VALUES = new Set(["all", "*", "true", "1"])

/** Configuration values resolved from `OPENCODE_*` environment variables. */
export type PluginConfig = {
  enabled: boolean
  logsEnabled: boolean
  endpoint: string
  protocol: "grpc" | "http/protobuf" | "http/json"
  metricsInterval: number
  logsInterval: number
  metricPrefix: string
  otlpHeaders: string | undefined
  otlpHeadersHelper: string | undefined
  resourceAttributes: string | undefined
  spanAttributes: string | undefined
  metricAttributes: string | undefined
  excludeMetricAttributes: Set<string>
  costUsageScale: number
  traceparent: string | undefined
  tracestate: string | undefined
  metricsTemporality: MetricsTemporality | undefined
  disabledMetrics: Set<string>
  disabledTraces: Set<string>
  tracePropagationProviders: Set<string>
}

export function parseAttributePairs(raw: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {}
  if (!raw) return attrs

  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=")
    if (idx <= 0) continue
    const key = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    if (!key) continue
    attrs[key] = value
  }

  return attrs
}

/**
 * Options accepted via the opencode plugin tuple form
 * (`["opencode-plugin-otel", { ... }]`). Every field is optional; a provided
 * value takes precedence over the matching `OPENCODE_*` environment variable,
 * which in turn wins over the built-in default. Field names mirror the resolved
 * {@link PluginConfig}.
 */
export type OtelPluginOptions = {
  enabled?: boolean
  logsEnabled?: boolean
  endpoint?: string
  protocol?: "grpc" | "http/protobuf" | "http/json"
  metricsInterval?: number
  logsInterval?: number
  metricPrefix?: string
  otlpHeaders?: string
  otlpHeadersHelper?: string
  resourceAttributes?: string
  spanAttributes?: string
  metricAttributes?: string
  excludeMetricAttributes?: string[]
  costUsageScale?: number
  traceparent?: string
  tracestate?: string
  metricsTemporality?: MetricsTemporality
  disabledMetrics?: string[]
  disabledTraces?: string[]
  tracePropagationProviders?: string[]
}

const VALID_PROTOCOLS = new Set<PluginConfig["protocol"]>(["grpc", "http/protobuf", "http/json"])

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function pickPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function pickPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function pickStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === "string")
}

function pickProtocol(value: unknown): PluginConfig["protocol"] | undefined {
  return typeof value === "string" && VALID_PROTOCOLS.has(value as PluginConfig["protocol"])
    ? (value as PluginConfig["protocol"])
    : undefined
}

function pickMetricsTemporality(value: unknown): MetricsTemporality | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.toLowerCase()
  return VALID_TEMPORALITIES.has(normalized as MetricsTemporality) ? (normalized as MetricsTemporality) : undefined
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
 * Parses a positive finite number (integer or decimal) from an environment variable.
 * Returns `fallback` when absent, non-numeric, zero, negative, or non-finite.
 */
export function parseEnvPositiveNumber(key: string, fallback: number): number {
  const raw = process.env[key]
  if (!raw) return fallback
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(raw)) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Returns `true` when the environment variable is present and non-empty. */
function hasNonEmptyEnv(key: string): boolean {
  return !!process.env[key]
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map(s => s.trim()).filter(Boolean)
}

function normalizeList(values: string[]): string[] {
  return values.map(s => s.trim()).filter(Boolean)
}

/** Builds the disabled-traces set from raw values, expanding global values like `all` to every trace type. */
function expandDisabledTraces(values: string[]): Set<string> {
  const normalized = values.map(v => v.trim().toLowerCase()).filter(Boolean)
  if (normalized.some(value => TRACE_DISABLE_ALL_VALUES.has(value))) {
    return new Set(TRACE_TYPES)
  }
  return new Set(normalized)
}

/**
 * Resolves the plugin config from plugin `options` and `OPENCODE_*` environment
 * variables. For every field a provided option wins over the environment
 * variable, which in turn wins over the built-in default.
 *
 * Copies the resolved headers, resource attributes, and metrics temporality into
 * `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_RESOURCE_ATTRIBUTES`, and
 * `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` so the OTel SDK picks them
 * up automatically when initialised.
 */
export function loadConfig(options: OtelPluginOptions = {}): PluginConfig {
  const resolvedOptions = typeof options === "object" && options !== null ? options : {}
  const otlpHeaders = pickString(resolvedOptions.otlpHeaders) ?? process.env["OPENCODE_OTLP_HEADERS"]
  const otlpHeadersHelper = pickString(resolvedOptions.otlpHeadersHelper) ?? process.env["OPENCODE_OTLP_HEADERS_HELPER"]
  const resourceAttributes = pickString(resolvedOptions.resourceAttributes) ?? process.env["OPENCODE_RESOURCE_ATTRIBUTES"]
  const spanAttributes = pickString(resolvedOptions.spanAttributes) ?? process.env["OPENCODE_SPAN_ATTRIBUTES"]
  const metricAttributes = pickString(resolvedOptions.metricAttributes) ?? process.env["OPENCODE_METRIC_ATTRIBUTES"]
  const traceparent = pickString(resolvedOptions.traceparent) ?? process.env["OPENCODE_TRACEPARENT"]
  const tracestate = pickString(resolvedOptions.tracestate) ?? process.env["OPENCODE_TRACESTATE"]
  const optionMetricsTemporality = pickMetricsTemporality(resolvedOptions.metricsTemporality)
  const envMetricsTemporality = pickMetricsTemporality(process.env["OPENCODE_OTLP_METRICS_TEMPORALITY"])
  const metricsTemporality = optionMetricsTemporality ?? envMetricsTemporality
  const protocol = pickProtocol(resolvedOptions.protocol)
    ?? pickProtocol(process.env["OPENCODE_OTLP_PROTOCOL"])
    ?? "grpc"

  if (
    optionMetricsTemporality === undefined
    && envMetricsTemporality === undefined
    && pickString(process.env["OPENCODE_OTLP_METRICS_TEMPORALITY"])
  ) {
    console.warn(
      `[opencode-plugin-otel] Invalid metrics temporality "${process.env["OPENCODE_OTLP_METRICS_TEMPORALITY"]}". ` +
        `Expected one of: cumulative, delta, lowmemory. Value ignored.`,
    )
  }

  if (metricsTemporality) process.env["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"] = metricsTemporality

  if (otlpHeaders) process.env["OTEL_EXPORTER_OTLP_HEADERS"] = otlpHeaders
  if (resourceAttributes) process.env["OTEL_RESOURCE_ATTRIBUTES"] = resourceAttributes

  const optionMetrics = pickStringList(resolvedOptions.disabledMetrics)
  const disabledMetrics = new Set(
    optionMetrics ? normalizeList(optionMetrics) : splitList(process.env["OPENCODE_DISABLE_METRICS"]),
  )

  const optionTraces = pickStringList(resolvedOptions.disabledTraces)
  const disabledTraces = expandDisabledTraces(optionTraces ?? splitList(process.env["OPENCODE_DISABLE_TRACES"]))

  const optionTracePropagationProviders = pickStringList(resolvedOptions.tracePropagationProviders)
  const tracePropagationProviders = new Set(
    optionTracePropagationProviders
      ? normalizeList(optionTracePropagationProviders)
      : splitList(process.env["OPENCODE_TRACE_PROPAGATION_PROVIDERS"]),
  )

  const optionExcludeMetricAttributes = pickStringList(resolvedOptions.excludeMetricAttributes)
  const excludeMetricAttributes = new Set(
    optionExcludeMetricAttributes
      ? normalizeList(optionExcludeMetricAttributes)
      : splitList(process.env["OPENCODE_EXCLUDE_METRICS_ATTRIBUTES"]),
  )

  const optionCostUsageScale = pickPositiveNumber(resolvedOptions.costUsageScale)
  const rawCostUsageScale = process.env["OPENCODE_COST_USAGE_SCALE"]
  const envCostUsageScale = parseEnvPositiveNumber("OPENCODE_COST_USAGE_SCALE", 1)
  const costUsageScale = optionCostUsageScale ?? envCostUsageScale
  if (
    optionCostUsageScale === undefined
    && rawCostUsageScale
    && envCostUsageScale === 1
    && rawCostUsageScale !== "1"
  ) {
    console.warn(
      `[opencode-plugin-otel] Invalid OPENCODE_COST_USAGE_SCALE="${rawCostUsageScale}". ` +
        `Expected a positive number (e.g. 1000000). Value ignored.`,
    )
  }

  return {
    enabled: pickBoolean(resolvedOptions.enabled) ?? hasNonEmptyEnv("OPENCODE_ENABLE_TELEMETRY"),
    logsEnabled: pickBoolean(resolvedOptions.logsEnabled) ?? !hasNonEmptyEnv("OPENCODE_DISABLE_LOGS"),
    endpoint: pickString(resolvedOptions.endpoint) ?? process.env["OPENCODE_OTLP_ENDPOINT"] ?? "http://localhost:4317",
    protocol,
    metricsInterval: pickPositiveInt(resolvedOptions.metricsInterval) ?? parseEnvInt("OPENCODE_OTLP_METRICS_INTERVAL", 60000),
    logsInterval: pickPositiveInt(resolvedOptions.logsInterval) ?? parseEnvInt("OPENCODE_OTLP_LOGS_INTERVAL", 5000),
    metricPrefix: pickString(resolvedOptions.metricPrefix) ?? process.env["OPENCODE_METRIC_PREFIX"] ?? "opencode.",
    otlpHeaders,
    otlpHeadersHelper,
    resourceAttributes,
    spanAttributes,
    metricAttributes,
    excludeMetricAttributes,
    costUsageScale,
    traceparent,
    tracestate,
    metricsTemporality,
    disabledMetrics,
    disabledTraces,
    tracePropagationProviders,
  }
}

export function resolveHelperPath(
  helper: string | undefined,
  directory: string | undefined,
  worktree: string | undefined,
): string | undefined {
  if (!helper) return helper
  const projectRoot = worktree ?? directory ?? process.cwd()
  return helper
    .replaceAll("${PROJECT_ROOT}", projectRoot)
    .replaceAll("${WORKTREE}", worktree ?? projectRoot)
    .replaceAll("${DIRECTORY}", directory ?? projectRoot)
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
