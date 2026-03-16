import { logs } from "@opentelemetry/api-logs"
import { metrics } from "@opentelemetry/api"
import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions"
import { ATTR_HOST_ARCH } from "@opentelemetry/semantic-conventions/incubating"
import type { Instruments } from "./types.ts"

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
  }
  const raw = process.env["OTEL_RESOURCE_ATTRIBUTES"]
  if (raw) {
    for (const pair of raw.split(",")) {
      const idx = pair.indexOf("=")
      if (idx > 0) {
        const key = pair.slice(0, idx).trim()
        const val = pair.slice(idx + 1).trim()
        if (key) attrs[key] = val
      }
    }
  }
  return resourceFromAttributes(attrs)
}

/** Handles returned by `setupOtel`, used for graceful shutdown. */
export type OtelProviders = {
  meterProvider: MeterProvider
  loggerProvider: LoggerProvider
}

/**
 * Initialises the OTel SDK — creates a `MeterProvider` and `LoggerProvider` backed by
 * OTLP/gRPC exporters pointed at `endpoint`, and registers them as the global providers.
 */
export function setupOtel(
  endpoint: string,
  metricsInterval: number,
  logsInterval: number,
  version: string,
): OtelProviders {
  const resource = buildResource(version)

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: endpoint }),
        exportIntervalMillis: metricsInterval,
      }),
    ],
  })
  metrics.setGlobalMeterProvider(meterProvider)

  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor(new OTLPLogExporter({ url: endpoint }), {
        scheduledDelayMillis: logsInterval,
      }),
    ],
  })
  logs.setGlobalLoggerProvider(loggerProvider)

  return { meterProvider, loggerProvider }
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
    costCounter: meter.createCounter(`${prefix}cost.usage`, {
      unit: "USD",
      description: "Cost of the opencode session in USD",
    }),
    linesCounter: meter.createCounter(`${prefix}lines_of_code.count`, {
      unit: "{line}",
      description: "Count of lines of code added or removed",
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
    }),
    modelUsageCounter: meter.createCounter(`${prefix}model.usage`, {
      unit: "{request}",
      description: "Number of completed assistant messages per model and provider",
    }),
    retryCounter: meter.createCounter(`${prefix}retry.count`, {
      unit: "{retry}",
      description: "Number of API retries observed via session.status events",
    }),
  }
}
