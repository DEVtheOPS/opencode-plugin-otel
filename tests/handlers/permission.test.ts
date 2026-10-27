import { describe, test, expect } from "bun:test"
import { handlePermissionAsked, handlePermissionReplied } from "../../src/handlers/permission.ts"
import { makeCtx, evt } from "../helpers.ts"

describe("handlePermissionAsked", () => {
  test("stores the pending permission", () => {
    const { ctx } = makeCtx()
    handlePermissionAsked(evt("permission.asked", { id: "perm_1", sessionID: "ses_1", action: "bash", resources: ["git push"] }), ctx)
    expect(ctx.tracing.pendingPermissions.get("perm_1")!.action).toBe("bash")
  })
})

describe("handlePermissionReplied", () => {
  test("emits an accept tool_decision", () => {
    const { ctx, logger } = makeCtx()
    handlePermissionAsked(evt("permission.asked", { id: "perm_1", sessionID: "ses_1", action: "bash", resources: ["git push"] }), ctx)
    handlePermissionReplied(evt("permission.replied", { sessionID: "ses_1", requestID: "perm_1", reply: "always" }), ctx)
    const record = logger.records.at(-1)!
    expect(record.body).toBe("tool_decision")
    expect(record.attributes?.["decision"]).toBe("accept")
    expect(record.attributes?.["tool_name"]).toBe("bash")
    expect(record.attributes?.["source"]).toBe("always")
  })

  test("emits a reject tool_decision", () => {
    const { ctx, logger } = makeCtx()
    handlePermissionAsked(evt("permission.asked", { id: "perm_2", sessionID: "ses_1", action: "edit", resources: ["a.ts"] }), ctx)
    handlePermissionReplied(evt("permission.replied", { sessionID: "ses_1", requestID: "perm_2", reply: "reject" }), ctx)
    expect(logger.records.at(-1)!.attributes?.["decision"]).toBe("reject")
  })
})
