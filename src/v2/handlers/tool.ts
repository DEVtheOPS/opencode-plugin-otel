import { SpanStatusCode } from "@opentelemetry/api"
import {
  INPUT_MIME_TYPE,
  INPUT_VALUE,
  MimeType,
  OpenInferenceSpanKind,
  OUTPUT_MIME_TYPE,
  OUTPUT_VALUE,
  SemanticConventions,
  SESSION_ID,
} from "@arizeai/openinference-semantic-conventions"
import { isMetricEnabled, isTraceEnabled, resolveSessionTraceContext, setBoundedMap } from "../util.ts"
import type { HandlerContext } from "../types.ts"
import { errorSummary, type V2Error, type V2ToolContent } from "../v2.ts"

const OPENINFERENCE_SPAN_KIND = SemanticConventions.OPENINFERENCE_SPAN_KIND
const TOOL_NAME = "tool.name"

/** Remembers the tool name for a call id, since V2 carries it only on `session.tool.input.started`. */
export function handleToolInputStarted(data: { sessionID: string; id: string; name?: string }, ctx: HandlerContext) {
  if (data.name) setBoundedMap(ctx.pendingToolNames, data.id, data.name)
}

/** Starts the tool span when the tool is called. */
export function handleToolCalled(
  data: { sessionID: string; id: string; input?: Record<string, unknown>; assistantMessageID?: string },
  ctx: HandlerContext,
) {
  const tool = ctx.pendingToolNames.get(data.id) ?? "unknown"
  if (!isTraceEnabled("tool", ctx)) return
  const span = ctx.tracer.startSpan(
    `${ctx.tracePrefix}tool.${tool}`,
    {
      startTime: Date.now(),
      attributes: {
        [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
        [SESSION_ID]: data.sessionID,
        [TOOL_NAME]: tool,
        [INPUT_VALUE]: ctx.redact(JSON.stringify(data.input ?? {})),
        [INPUT_MIME_TYPE]: MimeType.JSON,
        ...ctx.commonAttrs,
      },
    },
    resolveSessionTraceContext(data.sessionID, ctx, {
      assistantMessageID: data.assistantMessageID,
    }),
  )
  ctx.pendingToolSpans.set(data.id, { tool, sessionID: data.sessionID, startMs: Date.now(), span })
}

/** Ends the tool span successfully and records its duration. */
export function handleToolSuccess(
  data: { sessionID: string; id: string; content?: V2ToolContent[]; metadata?: Record<string, unknown> },
  ctx: HandlerContext,
) {
  finishTool(data.sessionID, data.id, ctx, data.content, undefined)
}

/** Ends the tool span with an error and records its duration. */
export function handleToolFailed(
  data: { sessionID: string; id: string; content?: V2ToolContent[]; error?: V2Error },
  ctx: HandlerContext,
) {
  finishTool(data.sessionID, data.id, ctx, data.content, data.error)
}

function finishTool(
  sessionID: string,
  id: string,
  ctx: HandlerContext,
  content: V2ToolContent[] | undefined,
  error: V2Error | undefined,
) {
  const pending = ctx.pendingToolSpans.get(id)
  const tool = pending?.tool ?? ctx.pendingToolNames.get(id) ?? "unknown"
  const startMs = pending?.startMs ?? Date.now()
  const duration = Date.now() - startMs

  const output = content?.map((part) => (part.type === "text" ? part.text : part.uri)).join("\n")
  if (pending?.span) {
    if (error) {
      pending.span.setStatus({ code: SpanStatusCode.ERROR, message: errorSummary(error) })
      pending.span.setAttribute("error", errorSummary(error))
    } else {
      pending.span.setStatus({ code: SpanStatusCode.OK })
    }
    if (output) {
      pending.span.setAttributes({ [OUTPUT_VALUE]: ctx.redact(output), [OUTPUT_MIME_TYPE]: MimeType.TEXT })
    }
    pending.span.end()
  }

  if (isMetricEnabled("tool.duration", ctx)) {
    ctx.instruments.toolDurationHistogram.record(duration, {
      ...ctx.commonAttrs,
      "session.id": sessionID,
      tool,
    })
  }

  ctx.pendingToolSpans.delete(id)
  ctx.pendingToolNames.delete(id)
  ctx.log("debug", error ? "otel: tool.failed" : "otel: tool.success", { sessionID, tool, duration })
}
