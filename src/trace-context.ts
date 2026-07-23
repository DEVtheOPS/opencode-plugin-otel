import {
  defaultTextMapGetter,
  defaultTextMapSetter,
  ROOT_CONTEXT,
  trace,
  type Context,
  type SpanContext,
} from "@opentelemetry/api"
import { W3CTraceContextPropagator } from "@opentelemetry/core"

const propagator = new W3CTraceContextPropagator()

/** Builds a remote parent context from W3C trace-context headers. */
export function remoteParentContext(traceparent: string | undefined, tracestate: string | undefined): Context | undefined {
  if (!traceparent) return undefined

  const carrier = tracestate ? { traceparent, tracestate } : { traceparent }
  const extracted = propagator.extract(ROOT_CONTEXT, carrier, defaultTextMapGetter)
  return trace.getSpanContext(extracted) ? extracted : undefined
}

/** Injects W3C trace context derived from an explicit span context into HTTP headers. */
export function injectTraceContext(spanContext: SpanContext, headers: Record<string, string>): void {
  propagator.inject(trace.setSpanContext(ROOT_CONTEXT, spanContext), headers, defaultTextMapSetter)
}
