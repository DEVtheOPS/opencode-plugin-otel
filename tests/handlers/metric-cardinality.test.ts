import { describe, test, expect } from "bun:test"
import { handleSessionCreated, handleSessionIdle, handleSessionDeleted, handleSessionStatus } from "../../src/handlers/session.ts"
import { handleMessageUpdated, handleMessagePartUpdated } from "../../src/handlers/message.ts"
import { handleSessionDiff, handleCommandExecuted } from "../../src/handlers/activity.ts"
import { handlePermissionUpdated, handlePermissionReplied } from "../../src/handlers/permission.ts"
import { makeCtx } from "../helpers.ts"
import type {
  EventSessionCreated,
  EventSessionIdle,
  EventSessionDeleted,
  EventSessionStatus,
  EventMessageUpdated,
  EventMessagePartUpdated,
  EventSessionDiff,
  EventCommandExecuted,
  EventPermissionUpdated,
  EventPermissionReplied,
} from "@opencode-ai/sdk"

function makeSessionCreated(sessionID: string, parentID?: string): EventSessionCreated {
  return {
    type: "session.created",
    properties: { info: { id: sessionID, projectID: "proj_test", directory: "/tmp", parentID, time: { created: 1000 } } },
  } as unknown as EventSessionCreated
}

function makeSessionIdle(sessionID: string): EventSessionIdle {
  return { type: "session.idle", properties: { sessionID } } as EventSessionIdle
}

function makeSessionDeleted(sessionID: string): EventSessionDeleted {
  return { type: "session.deleted", properties: { info: { id: sessionID } } } as unknown as EventSessionDeleted
}

function makeSessionStatus(sessionID: string): EventSessionStatus {
  return {
    type: "session.status",
    properties: { sessionID, status: { type: "retry", attempt: 1, message: "rate limited", next: 5000 } },
  } as unknown as EventSessionStatus
}

function makeAssistantMessage(opts: { sessionID?: string; error?: { name: string } } = {}): EventMessageUpdated {
  const sessionID = opts.sessionID ?? "ses_1"
  return {
    type: "message.updated",
    properties: {
      info: {
        id: "msg_1", role: "assistant", sessionID,
        modelID: "claude-3-5-sonnet", providerID: "anthropic",
        cost: 0.01,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 20, write: 5 } },
        time: { created: 1000, completed: 2000 },
        ...(opts.error ? { error: opts.error } : {}),
      },
    },
  } as unknown as EventMessageUpdated
}

function makeToolPart(status: "running" | "completed", sessionID = "ses_1"): EventMessagePartUpdated {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool", sessionID, callID: "call_1", messageID: "msg_1", tool: "bash",
        state: status === "running"
          ? { status: "running", time: { start: 1000 } }
          : { status: "completed", time: { start: 1000, end: 1500 }, output: "ok" },
      },
    },
  } as unknown as EventMessagePartUpdated
}

function makeSubtaskPart(sessionID = "ses_1"): EventMessagePartUpdated {
  return {
    type: "message.part.updated",
    properties: {
      part: { type: "subtask", sessionID, messageID: "msg_1", agent: "build", description: "desc", prompt: "prompt" },
    },
  } as unknown as EventMessagePartUpdated
}

function makeSessionDiff(sessionID = "ses_1"): EventSessionDiff {
  return {
    type: "session.diff",
    properties: { sessionID, diff: [{ file: "a.ts", additions: 10, deletions: 3 }] },
  } as unknown as EventSessionDiff
}

function makeCommandExecuted(cmd: string, sessionID = "ses_1"): EventCommandExecuted {
  return {
    type: "command.executed",
    properties: { sessionID, name: "bash", arguments: cmd },
  } as unknown as EventCommandExecuted
}

function makePermissionUpdated(id: string, sessionID = "ses_1"): EventPermissionUpdated {
  return {
    type: "permission.updated",
    properties: { id, sessionID, type: "bash", title: "Run bash", metadata: {}, time: { created: 1000 } },
  } as unknown as EventPermissionUpdated
}

function makePermissionReplied(id: string, sessionID = "ses_1"): EventPermissionReplied {
  return {
    type: "permission.replied",
    properties: { permissionID: id, sessionID, response: "allow" },
  } as unknown as EventPermissionReplied
}

/**
 * Every emitLog site reachable from a handler. `user_prompt` is excluded: it is emitted from the
 * plugin's `chat.message` hook in src/index.ts and needs a full plugin harness to reach. If a body
 * here stops appearing, the loop below fails rather than silently covering fewer sites.
 */
const EXPECTED_LOG_BODIES = [
  "api_error",
  "api_request",
  "commit",
  "session.created",
  "session.idle",
  "subtask_invoked",
  "tool_decision",
  "tool_result",
]

describe("metric cardinality", () => {
  test("no metric data point carries session.id (covers instruments registered in MockContext)", async () => {
    const mocks = makeCtx("proj_test", [], [], true, { team: "platform" })
    const { ctx } = mocks

    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    await handleMessageUpdated(makeAssistantMessage(), ctx)
    await handleMessageUpdated(makeAssistantMessage({ error: { name: "APIError" } }), ctx)
    await handleMessagePartUpdated(makeToolPart("running"), ctx)
    await handleMessagePartUpdated(makeToolPart("completed"), ctx)
    await handleMessagePartUpdated(makeSubtaskPart(), ctx)
    await handlePermissionUpdated(makePermissionUpdated("perm_1"), ctx)
    await handlePermissionReplied(makePermissionReplied("perm_1"), ctx)
    handleSessionStatus(makeSessionStatus("ses_1"), ctx)
    handleSessionDiff(makeSessionDiff(), ctx)
    handleCommandExecuted(makeCommandExecuted("git commit -m 'test'"), ctx)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    handleSessionDeleted(makeSessionDeleted("ses_1"), ctx)

    const instruments = [
      ...Object.entries(mocks.counters),
      ...Object.entries(mocks.histograms),
      ...Object.entries(mocks.gauges),
    ]

    expect(
      instruments.length,
      "HandlerContext.instruments has a member that MockContext does not register as a spy, so the loop below cannot see it",
    ).toBe(Object.keys(ctx.instruments).length)

    for (const [name, spy] of instruments) {
      expect(spy.calls.length, `instrument "${name}" recorded nothing, so this guard would pass vacuously`).toBeGreaterThan(0)
    }

    for (const [name, spy] of instruments) {
      for (const call of spy.calls) {
        expect(call.attrs["session.id"], `instrument "${name}" leaked session.id`).toBeUndefined()
        expect(call.attrs["project.id"]).toBe("proj_test")
        expect(call.attrs["team"]).toBe("platform")
      }
    }
  })

  test("every handler-reachable log event still carries session.id", async () => {
    const { ctx, logger } = makeCtx()
    await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
    await handleMessageUpdated(makeAssistantMessage(), ctx)
    await handleMessageUpdated(makeAssistantMessage({ error: { name: "APIError" } }), ctx)
    await handleMessagePartUpdated(makeToolPart("running"), ctx)
    await handleMessagePartUpdated(makeToolPart("completed"), ctx)
    await handleMessagePartUpdated(makeSubtaskPart(), ctx)
    await handlePermissionUpdated(makePermissionUpdated("perm_1"), ctx)
    await handlePermissionReplied(makePermissionReplied("perm_1"), ctx)
    handleSessionDiff(makeSessionDiff(), ctx)
    handleCommandExecuted(makeCommandExecuted("git commit -m 'test'"), ctx)
    handleSessionIdle(makeSessionIdle("ses_1"), ctx)
    handleSessionDeleted(makeSessionDeleted("ses_1"), ctx)

    const bodies = [...new Set(logger.records.map((r) => r.body))].sort()
    for (const body of EXPECTED_LOG_BODIES) {
      expect(bodies, `log event "${body}" was never emitted, so it is not actually covered here`).toContain(body)
    }

    for (const record of logger.records) {
      expect(record.attributes?.["session.id"], `log event "${record.body}" lost session.id`).toBe("ses_1")
    }
  })

  test("subagent session span still carries session.id", () => {
    const { ctx, tracer } = makeCtx()
    handleSessionCreated(makeSessionCreated("ses_child", "ses_parent"), ctx)
    expect(tracer.spans).toHaveLength(1)
    expect(tracer.spans[0]!.attributes["session.id"]).toBe("ses_child")
  })
})
