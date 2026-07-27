import { describe, test, expect, afterEach } from "bun:test"
import { metrics, type MeterProvider } from "@opentelemetry/api"
import { createInstruments } from "../src/otel.ts"
import { OTLPLogExporter as OTLPHttpLogExporter } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPLogExporter as OTLPProtoLogExporter } from "@opentelemetry/exporter-logs-otlp-proto"
import { OTLPMetricExporter as OTLPHttpMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPMetricExporter as OTLPProtoMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto"
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

  test("env resource attributes override defaults", () => {
    process.env["OTEL_RESOURCE_ATTRIBUTES"] = "service.name=my-override"
    const resource = buildResource("0.0.1")
    expect(resource.attributes["service.name"]).toBe("my-override")
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

  test("uses JSON HTTP exporters for http/json", async () => {
    providers = await setupOtel("http://collector:4318", "http/json", 60000, 5000, "1.2.3")
    const exporters = exportersOf(providers)

    expect(exporters.metric).toBeInstanceOf(OTLPHttpMetricExporter)
    expect(exporters.log).toBeInstanceOf(OTLPHttpLogExporter)
    expect(exporters.trace).toBeInstanceOf(OTLPHttpTraceExporter)
  })
})

describe("createInstruments metric attributes", () => {
  type RecordedCall = { value: number; attrs: Record<string, unknown> | undefined }

  function installFakeMeter() {
    const calls: RecordedCall[] = []
    const instrument = {
      add: (value: number, attrs?: Record<string, unknown>) => calls.push({ value, attrs }),
      record: (value: number, attrs?: Record<string, unknown>) => calls.push({ value, attrs }),
    }
    const meter = {
      createCounter: () => instrument,
      createHistogram: () => instrument,
      createGauge: () => instrument,
    }
    metrics.disable()
    metrics.setGlobalMeterProvider({ getMeter: () => meter } as unknown as MeterProvider)
    return calls
  }

  afterEach(() => metrics.disable())

  test("merges metric attributes into every recorded data point", () => {
    const calls = installFakeMeter()
    const instruments = createInstruments("opencode.", { team: "appgen", "deployment.environment": "production" })
    instruments.tokenCounter.add(10, { "session.id": "s1", type: "input" })
    instruments.toolDurationHistogram.record(5, { tool_name: "bash" })
    expect(calls[0]!.attrs).toEqual({ "session.id": "s1", type: "input", team: "appgen", "deployment.environment": "production" })
    expect(calls[1]!.attrs).toEqual({ tool_name: "bash", team: "appgen", "deployment.environment": "production" })
  })

  test("leaves attributes untouched when no metric attributes are configured", () => {
    const calls = installFakeMeter()
    const instruments = createInstruments("opencode.", {})
    instruments.costCounter.add(0.5, { model: "claude" })
    expect(calls[0]!.attrs).toEqual({ model: "claude" })
  })

  test("metric attributes override caller-supplied keys of the same name", () => {
    const calls = installFakeMeter()
    const instruments = createInstruments("opencode.", { env: "prod" })
    instruments.sessionCounter.add(1, { env: "dev" })
    expect(calls[0]!.attrs).toEqual({ env: "prod" })
  })

  test("strips excluded metric attributes from recorded data points", () => {
    const calls = installFakeMeter()
    const instruments = createInstruments("opencode.", {}, new Set(["session.id"]))
    instruments.tokenCounter.add(10, { "session.id": "s1", type: "input", model: "claude" })
    expect(calls[0]!.attrs).toEqual({ type: "input", model: "claude" })
  })

  test("exclusion wins over a configured metric attribute of the same key", () => {
    const calls = installFakeMeter()
    const instruments = createInstruments("opencode.", { env: "prod", "session.id": "static" }, new Set(["session.id"]))
    instruments.messageCounter.add(1, { "session.id": "s1", model: "claude" })
    expect(calls[0]!.attrs).toEqual({ model: "claude", env: "prod" })
  })
})

describe("createInstruments cost usage scale", () => {
  type Captured = { name: string; options: { unit?: string; description?: string } }

  function installCapturingMeter(): Captured[] {
    const captured: Captured[] = []
    const instrument = { add: () => {}, record: () => {} }
    const make = (name: string, options: { unit?: string; description?: string }) => {
      captured.push({ name, options })
      return instrument
    }
    const meter = {
      createCounter: make,
      createHistogram: make,
      createGauge: make,
    }
    metrics.disable()
    metrics.setGlobalMeterProvider({ getMeter: () => meter } as unknown as MeterProvider)
    return captured
  }

  afterEach(() => metrics.disable())

  test("declares USD units when costUsageScale is 1 (default)", () => {
    const captured = installCapturingMeter()
    createInstruments("opencode.")
    const cost = captured.find(c => c.name === "opencode.cost.usage")!
    const sessionCost = captured.find(c => c.name === "opencode.session.cost.total")!
    expect(cost.options.unit).toBe("USD")
    expect(sessionCost.options.unit).toBe("USD")
  })

  test("annotates cost.usage unit and description when costUsageScale is set", () => {
    const captured = installCapturingMeter()
    createInstruments("opencode.", {}, new Set(), 1_000_000)
    const cost = captured.find(c => c.name === "opencode.cost.usage")!
    expect(cost.options.unit).toBe("USD/1000000")
    expect(cost.options.description).toContain("1000000")
  })

  test("session.cost.total unit and description are not affected by costUsageScale", () => {
    const captured = installCapturingMeter()
    createInstruments("opencode.", {}, new Set(), 1_000_000)
    const sessionCost = captured.find(c => c.name === "opencode.session.cost.total")!
    expect(sessionCost.options.unit).toBe("USD")
    expect(sessionCost.options.description).not.toContain("1000000")
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
