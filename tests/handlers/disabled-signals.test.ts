import { describe, test, expect } from "bun:test"
import { handleSessionCreated, handleSessionIdle } from "../../src/handlers/session.ts"
import { handleMessageUpdated, handleMessagePartUpdated, startMessageSpan } from "../../src/handlers/message.ts"
import { handlePermissionReplied } from "../../src/handlers/permission.ts"
import { handleCommandExecuted } from "../../src/handlers/activity.ts"
import { makeCtx } from "../helpers.ts"
import type {
  EventCommandExecuted,
  EventMessagePartUpdated,
  EventMessageUpdated,
  EventPermissionReplied,
  EventSessionCreated,
  EventSessionIdle,
} from "@opencode-ai/sdk"

function makeSessionCreated(sessionID: string): EventSessionCreated {
  return {
    type: "session.created",
    properties: { info: { id: sessionID, projectID: "proj_test", directory: "/tmp", time: { created: 1000 } } },
  } as unknown as EventSessionCreated
}

function makeSessionIdle(sessionID: string): EventSessionIdle {
  return { type: "session.idle", properties: { sessionID } } as EventSessionIdle
}

function makeAssistantMessageUpdated(overrides: { error?: { name: string } } = {}): EventMessageUpdated {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: "msg_1",
        role: "assistant",
        sessionID: "ses_1",
        modelID: "claude-3-5-sonnet",
        providerID: "anthropic",
        cost: 0.01,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1000, completed: 2000 },
        error: overrides.error,
      },
    },
  } as unknown as EventMessageUpdated
}

function makeToolPartUpdated(status: "running" | "completed"): EventMessagePartUpdated {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool",
        sessionID: "ses_1",
        callID: "call_1",
        tool: "bash",
        state: status === "running"
          ? { status: "running", time: { start: 1000 } }
          : { status: "completed", time: { start: 1000, end: 1500 }, output: "ok" },
      },
    },
  } as unknown as EventMessagePartUpdated
}

function makePermissionReplied(): EventPermissionReplied {
  return {
    type: "permission.replied",
    properties: { permissionID: "perm_1", sessionID: "ses_1", response: "allow" },
  } as unknown as EventPermissionReplied
}

function makeCommandExecuted(cmd: string): EventCommandExecuted {
  return {
    type: "command.executed",
    properties: { sessionID: "ses_1", name: "bash", arguments: cmd },
  } as unknown as EventCommandExecuted
}

describe("disabled logs", () => {
  test("suppresses OTLP logs while leaving metrics enabled", async () => {
    const { ctx, logger, counters } = makeCtx("proj_test", [], [], false)
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    expect(logger.records).toHaveLength(0)
    expect(counters.session.calls).toHaveLength(1)
  })

  test("suppresses assistant request/error logs", async () => {
    const { ctx, logger } = makeCtx("proj_test", [], [], false)
    await handleMessageUpdated(makeAssistantMessageUpdated(), ctx)
    await handleMessageUpdated(makeAssistantMessageUpdated({ error: { name: "APIError" } }), ctx)
    expect(logger.records).toHaveLength(0)
  })

  test("suppresses tool, permission, commit, and idle logs", async () => {
    const { ctx, logger } = makeCtx("proj_test", [], [], false)
    ctx.pendingPermissions.set("perm_1", { type: "bash", title: "run bash", sessionID: "ses_1" })
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    await handleMessagePartUpdated(makeToolPartUpdated("running"), ctx)
    await handleMessagePartUpdated(makeToolPartUpdated("completed"), ctx)
    handlePermissionReplied(makePermissionReplied(), ctx)
    handleCommandExecuted(makeCommandExecuted("git commit -m 'test'"), ctx)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    expect(logger.records).toHaveLength(0)
  })
})

describe("disabled traces", () => {
  test("disabling all three trace types suppresses every span", async () => {
    const { ctx, tracer } = makeCtx("proj_test", [], ["session", "llm", "tool"])
    handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    startMessageSpan("ses_1", "msg_1", "user_1", "claude-3-5-sonnet", "anthropic", 1000, ctx)
    await handleMessagePartUpdated(makeToolPartUpdated("running"), ctx)
    expect(tracer.spans).toHaveLength(0)
  })
})
