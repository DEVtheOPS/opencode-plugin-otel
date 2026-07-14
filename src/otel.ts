import { logs } from "@opentelemetry/api-logs"
import { metrics, trace } from "@opentelemetry/api"
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc"
import { OTLPLogExporter as OTLPHttpLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPLogExporter as OTLPProtoLogExporter } from "@opentelemetry/exporter-logs-otlp-proto"
import { OTLPMetricExporter as OTLPHttpMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPMetricExporter as OTLPProtoMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"
import { OTLPTraceExporter as OTLPHttpTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPTraceExporter as OTLPProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"
import { ATTR_HOST_ARCH } from "@opentelemetry/semantic-conventions/incubating"
import type { Instruments } from "./types.ts"
import { parseAttributePairs } from "./config.ts"
import {
  createGrpcMetadata,
  DynamicHeaders,
  parseOtlpHeaders,
  RefreshingLogExporter,
  RefreshingMetricExporter,
  RefreshingSpanExporter,
  type HeadersMap,
} from "./headers.ts"

/**
 * Builds an OTel `Resource` seeded with `service.name`, `app.version`, `os.type`, and
 * `host.arch`. Additional attributes from `OTEL_RESOURCE_ATTRIBUTES` are merged in and
 * may override the defaults.
 */
export function buildResource(version: string) {
  const attrs: Record<string, string> = {
    [ATTR_SERVICE_NAME]: "opencode",
    "app.version": version,
    "os.type": process.platform,
    [ATTR_HOST_ARCH]: process.arch,
    ...parseAttributePairs(process.env["OTEL_RESOURCE_ATTRIBUTES"]),
  }
  return resourceFromAttributes(attrs)
}

/** Handles returned by `setupOtel`, used for graceful shutdown. */
export type OtelProviders = {
  meterProvider: MeterProvider
  loggerProvider: LoggerProvider
  tracerProvider: BasicTracerProvider
}

export async function forceFlushOtel(providers: OtelProviders) {
  await Promise.allSettled([
    providers.meterProvider.forceFlush(),
    providers.loggerProvider.forceFlush(),
    providers.tracerProvider.forceFlush(),
  ])
}

export function buildHttpSignalUrl(endpoint: string, signal: "traces" | "metrics" | "logs") {
  const url = new URL(endpoint)
  const normalizedPath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname
  url.pathname = `${normalizedPath}/v1/${signal}`
  return url.toString()
}

/**
 * Initialises the OTel SDK — creates a `MeterProvider`, `LoggerProvider`, and
 * `BasicTracerProvider` backed by OTLP exporters (gRPC or HTTP/protobuf)
 * pointed at `endpoint`, and registers them as the global providers.
 */
export async function setupOtel(
  endpoint: string,
  protocol: "grpc" | "http/protobuf" | "http/json",
  metricsInterval: number,
  logsInterval: number,
  version: string,
  otlpHeaders?: string,
  otlpHeadersHelper?: string,
): Promise<OtelProviders> {
  const resource = buildResource(version)
  const staticHeaders = parseOtlpHeaders(otlpHeaders)
  const dynamicHeaders = new DynamicHeaders(staticHeaders, otlpHeadersHelper)
  if (otlpHeadersHelper) {
    try {
      await dynamicHeaders.refresh()
    } catch (error) {
      console.warn("[opencode-plugin-otel] Failed to prewarm OTLP headers helper. Falling back to refresh-on-auth-failure.", error)
    }
  }
  const makeMetricExporter = (headers: HeadersMap) => protocol === "http/protobuf"
    ? new OTLPProtoMetricExporter({ url: buildHttpSignalUrl(endpoint, "metrics"), headers })
    : protocol === "http/json"
      ? new OTLPHttpMetricExporter({ url: buildHttpSignalUrl(endpoint, "metrics"), headers })
      : new OTLPMetricExporter({ url: endpoint, metadata: createGrpcMetadata(headers) })
  const makeLogExporter = (headers: HeadersMap) => protocol === "http/protobuf"
    ? new OTLPProtoLogExporter({ url: buildHttpSignalUrl(endpoint, "logs"), headers })
    : protocol === "http/json"
      ? new OTLPHttpLogExporter({ url: buildHttpSignalUrl(endpoint, "logs"), headers })
      : new OTLPLogExporter({ url: endpoint, metadata: createGrpcMetadata(headers) })
  const makeTraceExporter = (headers: HeadersMap) => protocol === "http/protobuf"
    ? new OTLPProtoTraceExporter({ url: buildHttpSignalUrl(endpoint, "traces"), headers })
    : protocol === "http/json"
      ? new OTLPHttpTraceExporter({ url: buildHttpSignalUrl(endpoint, "traces"), headers })
      : new OTLPTraceExporter({ url: endpoint, metadata: createGrpcMetadata(headers) })
  const metricExporter = otlpHeadersHelper
    ? new RefreshingMetricExporter(makeMetricExporter, dynamicHeaders)
    : makeMetricExporter(staticHeaders)
  const logExporter = otlpHeadersHelper
    ? new RefreshingLogExporter(makeLogExporter, dynamicHeaders)
    : makeLogExporter(staticHeaders)
  const traceExporter = otlpHeadersHelper
    ? new RefreshingSpanExporter(makeTraceExporter, dynamicHeaders)
    : makeTraceExporter(staticHeaders)

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: metricsInterval,
      }),
    ],
  })
  metrics.setGlobalMeterProvider(meterProvider)

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(logExporter, {
        scheduledDelayMillis: logsInterval,
      }),
    ],
  })
  logs.setGlobalLoggerProvider(loggerProvider)

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
  })
  trace.setGlobalTracerProvider(tracerProvider)

  return { meterProvider, loggerProvider, tracerProvider }
}

/** Creates all metric instruments using the global `MeterProvider`. Metric names are prefixed with `prefix`. */
export function createInstruments(prefix: string): Instruments {
  const meter = metrics.getMeter("com.opencode")
  return {
    sessionCounter: meter.createCounter(`${prefix}session.count`, {
      unit: "{session}",
      description: "Count of opencode sessions started",
    }),
    tokenCounter: meter.createCounter(`${prefix}token.usage`, {
      unit: "tokens",
      description: "Number of tokens used",
    }),
    // Deliberately not prefixed: the metric name is fixed by the OTel GenAI semantic
    // conventions, and semconv-strict backends (e.g. Splunk AI Agent Monitoring) only
    // recognise it under this exact name and as a Histogram.
    genaiTokenHistogram: meter.createHistogram("gen_ai.client.token.usage", {
      unit: "{token}",
      description: "Number of input and output tokens used, per OTel GenAI semantic conventions",
      advice: {
        explicitBucketBoundaries: [1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864],
      },
    }),
    costCounter: meter.createCounter(`${prefix}cost.usage`, {
      unit: "USD",
      description: "Cost of the opencode session in USD",
    }),
    linesCounter: meter.createCounter(`${prefix}lines_of_code.count`, {
      unit: "{line}",
      description: "Gross positive churn of lines added/removed across a session. Emits the positive delta vs. the previous session.diff; negative deltas (cumulative shrinkage) are dropped, so sums do not reconcile to net after any revert. Use lines_of_code.total for the authoritative live cumulative.",
    }),
    linesTotalGauge: meter.createGauge(`${prefix}lines_of_code.total`, {
      unit: "{line}",
      description: "Authoritative live cumulative lines added/removed for the current session. Mirrors opencode's session.diff cumulative value on every event; tracks partial and full reverts faithfully.",
    }),
    commitCounter: meter.createCounter(`${prefix}commit.count`, {
      unit: "{commit}",
      description: "Number of git commits created",
    }),
    toolDurationHistogram: meter.createHistogram(`${prefix}tool.duration`, {
      unit: "ms",
      description: "Duration of tool executions in milliseconds",
    }),
    cacheCounter: meter.createCounter(`${prefix}cache.count`, {
      unit: "{request}",
      description: "Token cache activity (cacheRead/cacheCreation) per completed assistant message",
    }),
    sessionDurationHistogram: meter.createHistogram(`${prefix}session.duration`, {
      unit: "ms",
      description: "Duration of a session from created to idle in milliseconds",
    }),
    messageCounter: meter.createCounter(`${prefix}message.count`, {
      unit: "{message}",
      description: "Number of completed assistant messages per session",
    }),
    sessionTokenGauge: meter.createHistogram(`${prefix}session.token.total`, {
      unit: "tokens",
      description: "Total tokens consumed per session, recorded as a histogram on session idle",
    }),
    sessionCostGauge: meter.createHistogram(`${prefix}session.cost.total`, {
      unit: "USD",
      description: "Total cost per session in USD, recorded as a histogram on session idle",
      advice: {
        explicitBucketBoundaries: [0.01, 0.05, 0.10, 0.25, 0.50, 1.00, 2.50, 5.00, 10.00, 25.00],
      },
    }),
    modelUsageCounter: meter.createCounter(`${prefix}model.usage`, {
      unit: "{request}",
      description: "Number of completed assistant messages per model and provider",
    }),
    retryCounter: meter.createCounter(`${prefix}retry.count`, {
      unit: "{retry}",
      description: "Number of API retries observed via session.status events",
    }),
    subtaskCounter: meter.createCounter(`${prefix}subtask.count`, {
      unit: "{subtask}",
      description: "Number of sub-agent invocations observed via subtask message parts",
    }),
  }
}
