import { describe, test, expect } from "bun:test"
import { handleSessionCreated, handleSessionIdle, handleSessionStatus } from "../../src/handlers/session.ts"
import { handleMessageUpdated, handleMessagePartUpdated } from "../../src/handlers/message.ts"
import { handleSessionDiff, handleCommandExecuted } from "../../src/handlers/activity.ts"
import { makeCtx } from "../helpers.ts"
import type { EventSessionCreated, EventSessionIdle, EventSessionStatus, EventMessageUpdated, EventMessagePartUpdated, EventSessionDiff, EventCommandExecuted } from "@opencode-ai/sdk"

function makeSessionCreated(sessionID: string): EventSessionCreated {
  return {
    type: "session.created",
    properties: { info: { id: sessionID, projectID: "proj_test", directory: "/tmp", time: { created: 1000 } } },
  } as unknown as EventSessionCreated
}

function makeSessionIdle(sessionID: string): EventSessionIdle {
  return { type: "session.idle", properties: { sessionID } } as EventSessionIdle
}

function makeSessionStatus(sessionID: string): EventSessionStatus {
  return {
    type: "session.status",
    properties: { sessionID, status: { type: "retry", attempt: 1, message: "rate limited", next: 5000 } },
  } as unknown as EventSessionStatus
}

function makeAssistantMessage(sessionID = "ses_1"): EventMessageUpdated {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: "msg_1", role: "assistant", sessionID,
        modelID: "claude-3-5-sonnet", providerID: "anthropic",
        cost: 0.01,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 20, write: 5 } },
        time: { created: 1000, completed: 2000 },
      },
    },
  } as unknown as EventMessageUpdated
}

function makeToolPart(status: "running" | "completed"): EventMessagePartUpdated {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "tool", sessionID: "ses_1", callID: "call_1", tool: "bash",
        state: status === "running"
          ? { status: "running", time: { start: 1000 } }
          : { status: "completed", time: { start: 1000, end: 1500 }, output: "ok" },
      },
    },
  } as unknown as EventMessagePartUpdated
}

function makeSessionDiff(): EventSessionDiff {
  return {
    type: "session.diff",
    properties: { sessionID: "ses_1", diff: [{ file: "a.ts", additions: 10, deletions: 3 }] },
  } as unknown as EventSessionDiff
}

function makeCommandExecuted(cmd: string): EventCommandExecuted {
  return {
    type: "command.executed",
    properties: { sessionID: "ses_1", name: "bash", arguments: cmd },
  } as unknown as EventCommandExecuted
}

describe("OPENCODE_DISABLE_METRICS", () => {
  describe("session.count disabled", () => {
    test("does not increment session counter", async () => {
      const { ctx, counters } = makeCtx("proj_test", ["session.count"])
      await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
      expect(counters.session.calls).toHaveLength(0)
    })

    test("still emits session.created log record", async () => {
      const { ctx, logger } = makeCtx("proj_test", ["session.count"])
      await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
      expect(logger.records.at(0)!.body).toBe("session.created")
    })
  })

  describe("session.duration disabled", () => {
    test("does not record duration histogram on idle", async () => {
      const { ctx, histograms } = makeCtx("proj_test", ["session.duration"])
      await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
      handleSessionIdle(makeSessionIdle("ses_1"), ctx)
      expect(histograms.sessionDuration.calls).toHaveLength(0)
    })
  })

  describe("session.token.total disabled", () => {
    test("does not record token gauge on idle", async () => {
      const { ctx, gauges } = makeCtx("proj_test", ["session.token.total"])
      await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
      handleSessionIdle(makeSessionIdle("ses_1"), ctx)
      expect(gauges.sessionToken.calls).toHaveLength(0)
    })
  })

  describe("session.cost.total disabled", () => {
    test("does not record cost gauge on idle", async () => {
      const { ctx, gauges } = makeCtx("proj_test", ["session.cost.total"])
      await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
      handleSessionIdle(makeSessionIdle("ses_1"), ctx)
      expect(gauges.sessionCost.calls).toHaveLength(0)
    })
  })

  describe("retry.count disabled", () => {
    test("does not increment retry counter", () => {
      const { ctx, counters } = makeCtx("proj_test", ["retry.count"])
      handleSessionStatus(makeSessionStatus("ses_1"), ctx)
      expect(counters.retry.calls).toHaveLength(0)
    })
  })

  describe("token.usage disabled", () => {
    test("does not increment token counter", async () => {
      const { ctx, counters } = makeCtx("proj_test", ["token.usage"])
      await handleMessageUpdated(makeAssistantMessage(), ctx)
      expect(counters.token.calls).toHaveLength(0)
    })

    test("still emits api_request log", async () => {
      const { ctx, logger } = makeCtx("proj_test", ["token.usage"])
      await handleMessageUpdated(makeAssistantMessage(), ctx)
      expect(logger.records.at(0)!.body).toBe("api_request")
    })
  })

  describe("cost.usage disabled", () => {
    test("does not increment cost counter", async () => {
      const { ctx, counters } = makeCtx("proj_test", ["cost.usage"])
      await handleMessageUpdated(makeAssistantMessage(), ctx)
      expect(counters.cost.calls).toHaveLength(0)
    })
  })

  describe("cache.count disabled", () => {
    test("does not increment cache counter", async () => {
      const { ctx, counters } = makeCtx("proj_test", ["cache.count"])
      await handleMessageUpdated(makeAssistantMessage(), ctx)
      expect(counters.cache.calls).toHaveLength(0)
    })
  })

  describe("message.count disabled", () => {
    test("does not increment message counter", async () => {
      const { ctx, counters } = makeCtx("proj_test", ["message.count"])
      await handleMessageUpdated(makeAssistantMessage(), ctx)
      expect(counters.message.calls).toHaveLength(0)
    })
  })

  describe("model.usage disabled", () => {
    test("does not increment model usage counter", async () => {
      const { ctx, counters } = makeCtx("proj_test", ["model.usage"])
      await handleMessageUpdated(makeAssistantMessage(), ctx)
      expect(counters.modelUsage.calls).toHaveLength(0)
    })
  })

  describe("tool.duration disabled", () => {
    test("does not record tool duration histogram", async () => {
      const { ctx, histograms } = makeCtx("proj_test", ["tool.duration"])
      await handleMessagePartUpdated(makeToolPart("running"), ctx)
      await handleMessagePartUpdated(makeToolPart("completed"), ctx)
      expect(histograms.tool.calls).toHaveLength(0)
    })

    test("still emits tool_result log", async () => {
      const { ctx, logger } = makeCtx("proj_test", ["tool.duration"])
      await handleMessagePartUpdated(makeToolPart("running"), ctx)
      await handleMessagePartUpdated(makeToolPart("completed"), ctx)
      expect(logger.records.at(0)!.body).toBe("tool_result")
    })
  })

  describe("lines_of_code.count disabled", () => {
    test("does not increment lines counter", () => {
      const { ctx, counters } = makeCtx("proj_test", ["lines_of_code.count"])
      handleSessionDiff(makeSessionDiff(), ctx)
      expect(counters.lines.calls).toHaveLength(0)
    })
  })

  describe("commit.count disabled", () => {
    test("does not increment commit counter", () => {
      const { ctx, counters } = makeCtx("proj_test", ["commit.count"])
      handleCommandExecuted(makeCommandExecuted("git commit -m 'test'"), ctx)
      expect(counters.commit.calls).toHaveLength(0)
    })

    test("still emits commit log record", () => {
      const { ctx, logger } = makeCtx("proj_test", ["commit.count"])
      handleCommandExecuted(makeCommandExecuted("git commit -m 'test'"), ctx)
      expect(logger.records.at(0)!.body).toBe("commit")
    })
  })

  describe("subtask.count disabled", () => {
    test("does not increment subtask counter", async () => {
      const { ctx, counters } = makeCtx("proj_test", ["subtask.count"])
      const e = {
        type: "message.part.updated",
        properties: {
          part: { type: "subtask", sessionID: "ses_1", messageID: "msg_1", agent: "build", description: "desc", prompt: "prompt" },
        },
      } as unknown as EventMessagePartUpdated
      await handleMessagePartUpdated(e, ctx)
      expect(counters.subtask.calls).toHaveLength(0)
    })

    test("still emits subtask_invoked log record", async () => {
      const { ctx, logger } = makeCtx("proj_test", ["subtask.count"])
      const e = {
        type: "message.part.updated",
        properties: {
          part: { type: "subtask", sessionID: "ses_1", messageID: "msg_1", agent: "build", description: "desc", prompt: "prompt" },
        },
      } as unknown as EventMessagePartUpdated
      await handleMessagePartUpdated(e, ctx)
      expect(logger.records.at(0)!.body).toBe("subtask_invoked")
    })
  })

  describe("multiple disabled at once", () => {
    test("disabling all metrics stops all counter/histogram calls", async () => {
      const all = [
        "session.count", "token.usage", "cost.usage", "lines_of_code.count",
        "commit.count", "tool.duration", "cache.count", "session.duration",
        "message.count", "session.token.total", "session.cost.total",
        "model.usage", "retry.count", "subtask.count",
      ]
      const { ctx, counters, histograms, gauges } = makeCtx("proj_test", all)
      const subtaskEvent = {
        type: "message.part.updated",
        properties: {
          part: { type: "subtask", sessionID: "ses_1", messageID: "msg_1", agent: "build", description: "desc", prompt: "prompt" },
        },
      } as unknown as EventMessagePartUpdated

      await handleSessionCreated(makeSessionCreated("ses_1"), ctx)
      await handleMessageUpdated(makeAssistantMessage(), ctx)
      handleSessionIdle(makeSessionIdle("ses_1"), ctx)
      handleSessionStatus(makeSessionStatus("ses_1"), ctx)
      handleSessionDiff(makeSessionDiff(), ctx)
      handleCommandExecuted(makeCommandExecuted("git commit -m 'test'"), ctx)
      await handleMessagePartUpdated(makeToolPart("running"), ctx)
      await handleMessagePartUpdated(makeToolPart("completed"), ctx)
      await handleMessagePartUpdated(subtaskEvent, ctx)

      expect(counters.session.calls).toHaveLength(0)
      expect(counters.token.calls).toHaveLength(0)
      expect(counters.cost.calls).toHaveLength(0)
      expect(counters.cache.calls).toHaveLength(0)
      expect(counters.message.calls).toHaveLength(0)
      expect(counters.modelUsage.calls).toHaveLength(0)
      expect(counters.retry.calls).toHaveLength(0)
      expect(counters.lines.calls).toHaveLength(0)
      expect(counters.commit.calls).toHaveLength(0)
      expect(counters.subtask.calls).toHaveLength(0)
      expect(histograms.tool.calls).toHaveLength(0)
      expect(histograms.sessionDuration.calls).toHaveLength(0)
      expect(gauges.sessionToken.calls).toHaveLength(0)
      expect(gauges.sessionCost.calls).toHaveLength(0)
    })
  })
})
