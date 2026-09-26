import { describe, test, expect, afterEach } from "bun:test"
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc"
import { OTLPLogExporter as OTLPHttpLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPLogExporter as OTLPProtoLogExporter } from "@opentelemetry/exporter-logs-otlp-proto"
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc"
import { OTLPMetricExporter as OTLPHttpMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { AggregationTemporality, InstrumentType } from "@opentelemetry/sdk-metrics"
import { OTLPMetricExporter as OTLPProtoMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc"
import { OTLPTraceExporter as OTLPHttpTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { OTLPTraceExporter as OTLPProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { buildResource, forceFlushOtel, setupOtel, type OtelProviders } from "../src/otel.ts"

let providers: OtelProviders | undefined

function exportersOf(currentProviders: OtelProviders) {
  const meterProvider = currentProviders.meterProvider as unknown as {
    _sharedState: { metricCollectors: Array<{ _metricReader: { _exporter: unknown } }> }
  }
  const loggerProvider = currentProviders.loggerProvider as unknown as {
    _sharedState: { activeProcessor: { processors: Array<{ _exporter: unknown }> } }
  }
  const tracerProvider = currentProviders.tracerProvider as unknown as {
    _activeSpanProcessor: { _spanProcessors: Array<{ _exporter: unknown }> }
  }
  const metricCollector = meterProvider._sharedState.metricCollectors[0]
  const logProcessor = loggerProvider._sharedState.activeProcessor.processors[0]
  const spanProcessor = tracerProvider._activeSpanProcessor._spanProcessors[0]

  if (!metricCollector || !logProcessor || !spanProcessor) {
    throw new Error("Expected OTEL providers to have active metric/log/trace exporters")
  }

  return {
    metric: metricCollector._metricReader._exporter,
    log: logProcessor._exporter,
    trace: spanProcessor._exporter,
  }
}

describe("buildResource", () => {
  const originalEnv = process.env["OTEL_RESOURCE_ATTRIBUTES"]
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["OTEL_RESOURCE_ATTRIBUTES"]
    } else {
      process.env["OTEL_RESOURCE_ATTRIBUTES"] = originalEnv
    }
  })

  test("includes service.name, app.version, os.type, host.arch", () => {
    delete process.env["OTEL_RESOURCE_ATTRIBUTES"]
    const resource = buildResource("1.2.3")
    const attrs = resource.attributes
    expect(attrs["service.name"]).toBe("opencode")
    expect(attrs["app.version"]).toBe("1.2.3")
    expect(attrs["os.type"]).toBe(process.platform)
    expect(attrs["host.arch"]).toBe(process.arch)
  })

  test("merges OTEL_RESOURCE_ATTRIBUTES from env", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "team=platform,env=prod"
    const resource = buildResource("0.0.1")
    const attrs = resource.attributes
    expect(attrs["team"]).toBe("platform")
    expect(attrs["env"]).toBe("prod")
  })

  test("trims whitespace in resource attributes", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = " team = platform "
    const resource = buildResource("0.0.1")
    expect(resource.attributes["team"]).toBe("platform")
  })

  test("resource attribute values may contain equals signs", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "auth=Bearer abc=123"
    const resource = buildResource("0.0.1")
    expect(resource.attributes["auth"]).toBe("Bearer abc=123")
  })

  test("env resource attributes override defaults", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "service.name=my-override"
    const resource = buildResource("0.0.1")
    expect(resource.attributes["service.name"]).toBe("my-override")
  })

  test("explicit accepted attributes ignore a rejected location's environment", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "team=rejected"
    expect(buildResource("2.0.0", "team=accepted").attributes["team"]).toBe("accepted")
    expect(buildResource("2.0.0", "").attributes["team"]).toBeUndefined()
  })
})

describe("setupOtel", () => {
  afterEach(async () => {
    const current = providers
    providers = undefined
    if (!current) return
    await Promise.allSettled([
      current.tracerProvider.shutdown(),
      current.loggerProvider.shutdown(),
      current.meterProvider.shutdown(),
    ])
  })

  test("uses protobuf HTTP exporters for http/protobuf", async () => {
    providers = await setupOtel("http://collector:4318", "http/protobuf", 60000, 5000, "1.2.3")
    const exporters = exportersOf(providers)

    expect(exporters.metric).toBeInstanceOf(OTLPProtoMetricExporter)
    expect(exporters.log).toBeInstanceOf(OTLPProtoLogExporter)
    expect(exporters.trace).toBeInstanceOf(OTLPProtoTraceExporter)
  })

  test("uses gRPC exporters for grpc", async () => {
    providers = await setupOtel("http://collector:4317", "grpc", 60000, 5000, "1.2.3")
    const exporters = exportersOf(providers)

    expect(exporters.metric).toBeInstanceOf(OTLPMetricExporter)
    expect(exporters.log).toBeInstanceOf(OTLPLogExporter)
    expect(exporters.trace).toBeInstanceOf(OTLPTraceExporter)
  })

  test("uses JSON HTTP exporters for http/json", async () => {
    providers = await setupOtel("http://collector:4318", "http/json", 60000, 5000, "1.2.3")
    const exporters = exportersOf(providers)

    expect(exporters.metric).toBeInstanceOf(OTLPHttpMetricExporter)
    expect(exporters.log).toBeInstanceOf(OTLPHttpLogExporter)
    expect(exporters.trace).toBeInstanceOf(OTLPHttpTraceExporter)
  })

  test("uses the accepted metrics temporality rather than a rejected setup's environment", async () => {
    const original = process.env["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"]
    try {
      process.env["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"] = "cumulative"
      providers = await setupOtel("http://collector:4318", "http/json", 60000, 5000, "2.0.0", undefined, undefined, "", "delta")
      const exporter = exportersOf(providers).metric as OTLPHttpMetricExporter
      expect(exporter.selectAggregationTemporality(InstrumentType.COUNTER)).toBe(AggregationTemporality.DELTA)
    } finally {
      if (original === undefined) delete process.env["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"]
      else process.env["OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE"] = original
    }
  })

  test("does not send inherited OTLP credentials when the accepted setup has no headers", async () => {
    const previous = process.env["OTEL_EXPORTER_OTLP_HEADERS"]
    const previousMetrics = process.env["OTEL_EXPORTER_OTLP_METRICS_HEADERS"]
    const received: Headers[] = []
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        received.push(request.headers)
        return new Response(null, { status: 200 })
      },
    })
    try {
      process.env["OTEL_EXPORTER_OTLP_HEADERS"] = "Authorization=Bearer rejected"
      process.env["OTEL_EXPORTER_OTLP_METRICS_HEADERS"] = "x-rejected=secret"
      providers = await setupOtel(`http://127.0.0.1:${server.port}`, "http/json", 60000, 5000, "2.0.0")
      providers.meterProvider.getMeter("test").createCounter("test.counter").add(1)
      await providers.meterProvider.forceFlush()
      expect(received.length).toBeGreaterThan(0)
      expect(received[0]!.get("authorization")).toBeNull()
      expect(received[0]!.get("x-rejected")).toBeNull()
    } finally {
      const active = providers
      providers = undefined
      if (active) await Promise.allSettled([
        active.meterProvider.shutdown(), active.loggerProvider.shutdown(), active.tracerProvider.shutdown(),
      ])
      if (previous === undefined) delete process.env["OTEL_EXPORTER_OTLP_HEADERS"]
      else process.env["OTEL_EXPORTER_OTLP_HEADERS"] = previous
      if (previousMetrics === undefined) delete process.env["OTEL_EXPORTER_OTLP_METRICS_HEADERS"]
      else process.env["OTEL_EXPORTER_OTLP_METRICS_HEADERS"] = previousMetrics
      server.stop()
    }
  })
})

describe("forceFlushOtel", () => {
  test("flushes metrics, logs, and traces", async () => {
    const calls: string[] = []
    const fakeProviders = {
      meterProvider: { forceFlush: async () => { calls.push("metrics") } },
      loggerProvider: { forceFlush: async () => { calls.push("logs") } },
      tracerProvider: { forceFlush: async () => { calls.push("traces") } },
    } as unknown as OtelProviders

    await forceFlushOtel(fakeProviders)

    expect(calls.sort()).toEqual(["logs", "metrics", "traces"])
  })
})
