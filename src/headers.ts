import { createRequire } from "module"
import { execFile } from "node:child_process"
import { ExportResultCode, type ExportResult } from "@opentelemetry/core"
import type { PushMetricExporter, ResourceMetrics } from "@opentelemetry/sdk-metrics"
import type { SpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-base"
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs"
import type { Metadata } from "@grpc/grpc-js"

const require = createRequire(import.meta.url)
const DEFAULT_HELPER_TIMEOUT_MS = 5000

type Exporter<T> = {
  export(items: T, resultCallback: (result: ExportResult) => void): void
  shutdown(): Promise<void>
  forceFlush?(): Promise<void>
}

type SelectAggregation = NonNullable<PushMetricExporter["selectAggregation"]>
type SelectAggregationTemporality = NonNullable<PushMetricExporter["selectAggregationTemporality"]>

export type HeadersMap = Record<string, string>

export function parseOtlpHeaders(raw: string | undefined): HeadersMap {
  if (!raw) return {}
  const headers: HeadersMap = {}
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=")
    if (idx > 0) {
      const key = pair.slice(0, idx).trim()
      const val = pair.slice(idx + 1).trim()
      if (key) headers[key] = val
    }
  }
  return headers
}

export function createGrpcMetadata(headers: HeadersMap): Metadata {
  const { Metadata } = require("@grpc/grpc-js") as typeof import("@grpc/grpc-js")
  const metadata = new Metadata()
  for (const [key, value] of Object.entries(headers)) metadata.set(key, value)
  return metadata
}

export function isAuthFailure(error: unknown): boolean {
  if (!error) return false
  const err = error as Record<string, unknown>
  const numericStatus = Number(err["status"] ?? err["statusCode"] ?? err["code"])
  if ([401, 403, 7, 16].includes(numericStatus)) return true
  const message = error instanceof Error ? error.message : String(error)
  return /\b(401|403)\b|unauthenticated|permission denied|unauthorized|forbidden/i.test(message)
}

export class DynamicHeaders {
  private headers: HeadersMap
  private version = 0
  private refreshPromise: Promise<number> | undefined

  constructor(
    private readonly staticHeaders: HeadersMap,
    private readonly helper: string | undefined,
    private readonly helperTimeoutMs = DEFAULT_HELPER_TIMEOUT_MS,
  ) {
    this.headers = { ...staticHeaders }
  }

  current(): HeadersMap {
    return { ...this.headers }
  }

  currentVersion(): number {
    return this.version
  }

  refresh(): Promise<number> {
    if (!this.helper) return Promise.resolve(this.version)
    if (!this.refreshPromise) {
      this.refreshPromise = this.runHelper()
        .then((helperHeaders) => {
          const next = { ...this.staticHeaders, ...helperHeaders }
          const changed = headerSignature(next) !== headerSignature(this.headers)
          this.headers = next
          if (changed) this.version += 1
          return this.version
        })
        .finally(() => {
          this.refreshPromise = undefined
        })
    }
    return this.refreshPromise
  }

  private async runHelper(): Promise<HeadersMap> {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        this.helper!,
        [],
        { timeout: this.helperTimeoutMs, killSignal: "SIGTERM", maxBuffer: 1024 * 1024 },
        (error, out, err) => {
          if (error) {
            const signal = (error as NodeJS.ErrnoException & { signal?: string | null }).signal
            if (signal) {
              reject(new Error(`OTLP headers helper was terminated by ${signal}`))
              return
            }
            const detail = (err ?? "").trim() || error.message
            reject(new Error(`OTLP headers helper failed: ${detail}`))
            return
          }
          resolve(out)
        },
      )
    })
    const parsed = JSON.parse(stdout) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OTLP headers helper must return a JSON object")
    }
    const headers: HeadersMap = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") throw new Error(`OTLP headers helper returned non-string value for ${key}`)
      headers[key] = value
    }
    return headers
  }
}

export class RefreshingMetricExporter implements PushMetricExporter {
  private exporter: PushMetricExporter
  private headersVersion: number

  constructor(
    private readonly createExporter: (headers: HeadersMap) => PushMetricExporter,
    private readonly dynamicHeaders: DynamicHeaders,
  ) {
    this.exporter = createExporter(dynamicHeaders.current())
    this.headersVersion = dynamicHeaders.currentVersion()
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    exportWithAuthRetry(this, metrics, resultCallback)
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush()
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown()
  }

  selectAggregationTemporality(
    instrumentType: Parameters<SelectAggregationTemporality>[0],
  ): ReturnType<SelectAggregationTemporality> {
    return this.exporter.selectAggregationTemporality!(instrumentType)
  }

  selectAggregation(instrumentType: Parameters<SelectAggregation>[0]): ReturnType<SelectAggregation> {
    return this.exporter.selectAggregation!(instrumentType)
  }

  _exporter(): PushMetricExporter {
    return this.exporter
  }

  _replaceExporter(version: number): void {
    const old = this.exporter
    this.exporter = this.createExporter(this.dynamicHeaders.current())
    this.headersVersion = version
    old.shutdown().catch(() => {})
  }

  _refreshHeaders(): Promise<number> {
    return this.dynamicHeaders.refresh()
  }

  _headersVersion(): number {
    return this.headersVersion
  }
}

export class RefreshingSpanExporter implements SpanExporter {
  private exporter: SpanExporter
  private headersVersion: number

  constructor(
    private readonly createExporter: (headers: HeadersMap) => SpanExporter,
    private readonly dynamicHeaders: DynamicHeaders,
  ) {
    this.exporter = createExporter(dynamicHeaders.current())
    this.headersVersion = dynamicHeaders.currentVersion()
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    exportWithAuthRetry(this, spans, resultCallback)
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.() ?? Promise.resolve()
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown()
  }

  _exporter(): SpanExporter {
    return this.exporter
  }

  _replaceExporter(version: number): void {
    const old = this.exporter
    this.exporter = this.createExporter(this.dynamicHeaders.current())
    this.headersVersion = version
    old.shutdown().catch(() => {})
  }

  _refreshHeaders(): Promise<number> {
    return this.dynamicHeaders.refresh()
  }

  _headersVersion(): number {
    return this.headersVersion
  }
}

export class RefreshingLogExporter implements LogRecordExporter {
  private exporter: LogRecordExporter
  private headersVersion: number

  constructor(
    private readonly createExporter: (headers: HeadersMap) => LogRecordExporter,
    private readonly dynamicHeaders: DynamicHeaders,
  ) {
    this.exporter = createExporter(dynamicHeaders.current())
    this.headersVersion = dynamicHeaders.currentVersion()
  }

  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    exportWithAuthRetry(this, logs, resultCallback)
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown()
  }

  _exporter(): LogRecordExporter {
    return this.exporter
  }

  _replaceExporter(version: number): void {
    const old = this.exporter
    this.exporter = this.createExporter(this.dynamicHeaders.current())
    this.headersVersion = version
    old.shutdown().catch(() => {})
  }

  _refreshHeaders(): Promise<number> {
    return this.dynamicHeaders.refresh()
  }

  _headersVersion(): number {
    return this.headersVersion
  }
}

function exportWithAuthRetry<T>(
  wrapper: {
    _exporter(): Exporter<T>
    _replaceExporter(version: number): void
    _refreshHeaders(): Promise<number>
    _headersVersion(): number
  },
  items: T,
  resultCallback: (result: ExportResult) => void,
): void {
  wrapper._exporter().export(items, (result) => {
    if (result.code !== ExportResultCode.FAILED || !isAuthFailure(result.error)) {
      resultCallback(result)
      return
    }
    wrapper._refreshHeaders()
      .then((version) => {
        if (version !== wrapper._headersVersion()) wrapper._replaceExporter(version)
        wrapper._exporter().export(items, resultCallback)
      })
      .catch((error: unknown) => {
        resultCallback({ code: ExportResultCode.FAILED, error: error instanceof Error ? error : new Error(String(error)) })
      })
  })
}

function headerSignature(headers: HeadersMap): string {
  return JSON.stringify(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)))
}
