import { SeverityNumber } from "@opentelemetry/api-logs"
import { SpanKind, SpanStatusCode } from "@opentelemetry/api"
import {
  AGENT_NAME,
  INPUT_MIME_TYPE,
  INPUT_VALUE,
  MimeType,
  OpenInferenceSpanKind,
  OUTPUT_MIME_TYPE,
  OUTPUT_VALUE,
  SemanticConventions,
  SESSION_ID,
  TOOL_ID,
  TOOL_NAME,
  TOOL_PARAMETERS,
} from "@arizeai/openinference-semantic-conventions"
import type { EventOf, HandlerContext } from "../types.ts"
import {
  agentAttrs,
  errorSummary,
  getSessionAgentMeta,
  isMetricEnabled,
  isTraceEnabled,
  resolveStepContext,
  setBoundedMap,
} from "../util.ts"

const OPENINFERENCE_SPAN_KIND = SemanticConventions.OPENINFERENCE_SPAN_KIND
const GIT_COMMIT_RE = /\bgit\s+commit(?![-\w])/
const SHELL_TOOL_RE = /(^|\.)(bash|shell)$/i

type ToolContent = { type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string }

/** Records the tool name for correlation with its execution and terminal events. */
export function handleToolInputStarted(e: EventOf<"session.tool.input.started">, ctx: HandlerContext) {
  const d = e.data
  setBoundedMap(ctx.tracing.toolMeta, d.id, {
    sessionID: d.sessionID,
    assistantMessageID: d.assistantMessageID,
    tool: d.name,
    startMs: e.created,
  })
}

/** Starts timing and tracing an observed tool call, and retains the command for commit detection. */
export function handleToolCalled(e: EventOf<"session.tool.called">, ctx: HandlerContext) {
  const d = e.data
  const meta = ctx.tracing.toolMeta.get(d.id)
  if (!meta) return
  const isSubagent = meta.tool === "subagent"
  setBoundedMap(ctx.tracing.toolMeta, d.id, {
    ...meta,
    startMs: e.created,
    executionStarted: true,
    ...(isSubagent && typeof d.input["agent"] === "string" ? { agent: d.input["agent"] } : {}),
    ...(typeof d.input["command"] === "string" ? { command: d.input["command"] } : {}),
  })

  if (!isTraceEnabled("tool", ctx)) return
  if (isSubagent) startSubagentSpan(d.id, ctx)
  else {
    const span = ctx.tracer.startSpan(
      `${ctx.tracePrefix}tool.${meta.tool}`,
      {
        startTime: e.created,
        kind: SpanKind.INTERNAL,
        attributes: {
          [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
          [SESSION_ID]: d.sessionID,
          [TOOL_ID]: d.id,
          [TOOL_NAME]: meta.tool,
          ...ctx.commonAttrs,
        },
      },
      resolveStepContext(d.sessionID, d.assistantMessageID, ctx),
    )
    setBoundedMap(ctx.tracing.toolSpans, d.id, span)
    setBoundedMap(ctx.tracing.toolSpanContexts, d.id, span.spanContext())
  }

  const { agentName, agentType } = getSessionAgentMeta(d.sessionID, ctx)
  const inputJson = safeJson(d.input)
  ctx.tracing.toolSpans.get(d.id)?.setAttributes({
    [TOOL_PARAMETERS]: inputJson,
    [INPUT_VALUE]: inputJson,
    [INPUT_MIME_TYPE]: MimeType.JSON,
    [AGENT_NAME]: agentName,
    "agent.type": agentType,
    "tool.provider_executed": isProviderExecuted(d),
  })
}

type ProviderExecution = {
  readonly executed?: boolean
  readonly provider?: { readonly executed?: boolean }
}

function isProviderExecuted(data: ProviderExecution): boolean {
  return data.provider?.executed ?? data.executed ?? false
}

function startSubagentSpan(callID: string, ctx: HandlerContext) {
  const meta = ctx.tracing.toolMeta.get(callID)
  if (!meta || meta.tool !== "subagent") return
  setBoundedMap(ctx.tracing.toolMeta, callID, { ...meta, executionStarted: true })
  if (ctx.tracing.toolSpans.has(callID) || !isTraceEnabled("tool", ctx)) return
  const { agentName, agentType } = getSessionAgentMeta(meta.sessionID, ctx)
  const span = ctx.tracer.startSpan(
    `${ctx.tracePrefix}tool.subagent`,
    {
      startTime: meta.startMs,
      kind: SpanKind.INTERNAL,
      attributes: {
        [OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
        [SESSION_ID]: meta.sessionID,
        [TOOL_ID]: callID,
        [TOOL_NAME]: "subagent",
        "subagent.agent": meta.agent ?? "unknown",
        [AGENT_NAME]: agentName,
        "agent.type": agentType,
        ...ctx.commonAttrs,
      },
    },
    resolveStepContext(meta.sessionID, meta.assistantMessageID, ctx),
  )
  setBoundedMap(ctx.tracing.toolSpans, callID, span)
  setBoundedMap(ctx.tracing.toolSpanContexts, callID, span.spanContext())
}

function linkSubagent(callID: string, childID: unknown, ctx: HandlerContext) {
  const meta = ctx.tracing.toolMeta.get(callID)
  if (typeof childID !== "string" || meta?.tool !== "subagent" || ctx.tracing.consumedSubagentDispatches.has(callID)) return
  setBoundedMap(ctx.tracing.toolMeta, callID, { ...meta, childSessionID: childID })
  startSubagentSpan(callID, ctx)
  const span = ctx.tracing.toolSpans.get(callID)
  span?.setAttribute("subagent.session_id", childID)
  const spanContext = span?.spanContext()
  if (spanContext) setBoundedMap(ctx.tracing.subagentParents, childID, { spanContext, callID })
}

export function handleToolProgress(e: EventOf<"session.tool.progress">, ctx: HandlerContext) {
  linkSubagent(e.data.id, e.data.metadata["sessionID"], ctx)
}

/** Ends a successful tool call: records duration, sets output attributes, and emits `tool_result`. */
export function handleToolSuccess(e: EventOf<"session.tool.success">, ctx: HandlerContext) {
  linkSubagent(e.data.id, e.data.metadata?.["sessionID"], ctx)
  const output = contentText(e.data.content)
  finishTool(e.data.id, e.data.sessionID, e.created, true, output, undefined, ctx)
}

/** Ends a failed tool call: records duration, sets error attributes, and emits `tool_result`. */
export function handleToolFailed(e: EventOf<"session.tool.failed">, ctx: HandlerContext) {
  linkSubagent(e.data.id, e.data.metadata?.["sessionID"], ctx)
  const output = contentText(e.data.content)
  finishTool(e.data.id, e.data.sessionID, e.created, false, output, errorSummary(e.data.error), ctx)
}

function finishTool(
  callID: string,
  sessionID: string,
  endMs: number,
  success: boolean,
  output: string,
  error: string | undefined,
  ctx: HandlerContext,
) {
  const meta = ctx.tracing.toolMeta.get(callID)
  ctx.tracing.toolMeta.delete(callID)
  const tool = meta?.tool ?? "unknown"
  const observedExecution = meta?.executionStarted === true
  const start = observedExecution ? meta.startMs : endMs
  const durationMs = Math.max(0, endMs - start)
  const { agentName, agentType } = getSessionAgentMeta(sessionID, ctx)
  const sizeBytes = output ? Buffer.byteLength(output, "utf8") : 0

  if (success && observedExecution && meta.command && SHELL_TOOL_RE.test(tool) && GIT_COMMIT_RE.test(meta.command)) {
    if (isMetricEnabled("commit.count", ctx)) {
      ctx.instruments.commitCounter.add(1, { ...ctx.commonAttrs, "session.id": sessionID })
    }
    ctx.emitLog({
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      timestamp: endMs,
      observedTimestamp: Date.now(),
      body: "commit",
      attributes: {
        "event.name": "commit",
        "session.id": sessionID,
        ...agentAttrs(agentName, agentType),
        ...ctx.commonAttrs,
      },
    })
  }

  if (observedExecution && isMetricEnabled("tool.duration", ctx)) {
    ctx.instruments.toolDurationHistogram.record(durationMs, {
      ...ctx.commonAttrs,
      "session.id": sessionID,
      tool_name: tool,
      success,
    })
  }

  const span = ctx.tracing.toolSpans.get(callID)
  if (span) {
    span.setAttributes({ [AGENT_NAME]: agentName, "agent.type": agentType, "tool.success": success })
    if (output) {
      span.setAttributes({ [OUTPUT_VALUE]: output, [OUTPUT_MIME_TYPE]: MimeType.TEXT })
    }
    if (success) {
      span.setAttribute("tool.result_size_bytes", sizeBytes)
      span.setStatus({ code: SpanStatusCode.OK })
    } else {
      span.setAttribute("tool.error", error ?? "unknown")
      span.setStatus({ code: SpanStatusCode.ERROR, message: error ?? "unknown" })
    }
    span.end(endMs)
  }
  ctx.tracing.toolSpans.delete(callID)
  ctx.tracing.toolSpanContexts.delete(callID)

  ctx.emitLog({
    severityNumber: success ? SeverityNumber.INFO : SeverityNumber.ERROR,
    severityText: success ? "INFO" : "ERROR",
    timestamp: start,
    observedTimestamp: Date.now(),
    body: "tool_result",
    attributes: {
      "event.name": "tool_result",
      "session.id": sessionID,
      tool_name: tool,
      ...agentAttrs(agentName, agentType),
      success,
      duration_ms: durationMs,
      ...(success ? { tool_result_size_bytes: sizeBytes } : { error: error ?? "unknown" }),
      ...ctx.commonAttrs,
    },
  })
}

function contentText(content: readonly ToolContent[] | undefined): string {
  if (!content) return ""
  return content
    .map((part) => (part.type === "text" ? part.text : part.name ?? part.uri))
    .filter(Boolean)
    .join("\n")
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}
