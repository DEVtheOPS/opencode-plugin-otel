import { describe, test, expect } from "bun:test"
import { SpanStatusCode } from "@opentelemetry/api"
import { handlePermissionAsked, handlePermissionReplied, sweepPermissionSpans } from "../../src/handlers/permission.ts"
import { handleStepStarted } from "../../src/handlers/step.ts"
import { makeCtx, evt } from "../helpers.ts"

function asked(id = "perm_1", at = 1000) {
  return evt("permission.asked", { id, sessionID: "ses_1", action: "bash", resources: ["ls -la"] }, at)
}

function replied(id = "perm_1", reply: "accept" | "reject" | "always" = "accept", at = 5000) {
  return evt("permission.replied", { requestID: id, sessionID: "ses_1", reply }, at)
}

describe("permission spans", () => {
  test("records the approval wait under the active step span", () => {
    const { ctx, tracer } = makeCtx()
    handleStepStarted(evt("session.step.started", { sessionID: "ses_1", assistantMessageID: "msg_1", agent: "build", model: { id: "m", providerID: "p" }, started: 1 }), ctx)
    handlePermissionAsked(asked(), ctx)
    handlePermissionReplied(replied(), ctx)
    const step = tracer.spans.find((s) => s.name === "opencode.llm")!
    const span = tracer.spans.find((s) => s.name === "opencode.permission")!
    expect(span.parentSpanContext).toBe(step.spanContext())
    expect(span.startTime).toBe(1000)
    expect(span.endTime).toBe(5000)
    expect(span.attributes["permission.decision"]).toBe("accept")
    expect(span.status.code).toBe(SpanStatusCode.OK)
    expect(ctx.tracing.permissionSpans.size).toBe(0)
  })

  test("falls back to the run span when no step is active", () => {
    const { ctx, tracer } = makeCtx()
    handlePermissionAsked(asked(), ctx)
    handlePermissionReplied(replied("perm_1", "reject"), ctx)
    const span = tracer.spans.find((s) => s.name === "opencode.permission")!
    expect(span.attributes["permission.decision"]).toBe("reject")
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
  })

  test("does not create spans when permission tracing is disabled", () => {
    const { ctx, tracer } = makeCtx("proj_test", [], ["permission"])
    handlePermissionAsked(asked(), ctx)
    handlePermissionReplied(replied(), ctx)
    expect(tracer.spans.filter((s) => s.name === "opencode.permission")).toHaveLength(0)
  })

  test("sweep ends a permission span that was never answered", () => {
    const { ctx, tracer } = makeCtx()
    handlePermissionAsked(asked(), ctx)
    sweepPermissionSpans("ses_1", ctx)
    const span = tracer.spans.find((s) => s.name === "opencode.permission")!
    expect(span.ended).toBe(true)
    expect(span.attributes["permission.decision"]).toBe("cancelled")
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
  })
})
