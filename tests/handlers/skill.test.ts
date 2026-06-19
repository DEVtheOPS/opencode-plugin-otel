import { describe, test, expect } from "bun:test"
import { createSkillCommandResolver, handleCommandExecuteBefore } from "../../src/handlers/skill.ts"
import { makeCtx } from "../helpers.ts"

function commandInput(command = "review") {
  return {
    command,
    sessionID: "ses_1",
    arguments: "sensitive prompt text",
  }
}

describe("handleCommandExecuteBefore", () => {
  test("increments skill counter when command resolves to a skill", async () => {
    const { ctx, counters } = makeCtx("proj_test")

    await handleCommandExecuteBefore(commandInput(), ctx, async () => ({
      name: "review",
      agent: "build",
      subtask: true,
    }))

    expect(counters.skill.calls).toHaveLength(1)
    expect(counters.skill.calls[0]!.attrs).toEqual({
      "project.id": "proj_test",
      "session.id": "ses_1",
      skill_name: "review",
      invocation_type: "command",
      command_name: "review",
      agent: "build",
      subtask: true,
    })
  })

  test("emits skill_invoked log without raw command arguments", async () => {
    const { ctx, logger } = makeCtx("proj_test")

    await handleCommandExecuteBefore(commandInput(), ctx, async () => ({
      name: "review",
      description: "Review the current diff",
    }))

    const record = logger.records.at(0)!
    expect(record.body).toBe("skill_invoked")
    expect(record.attributes?.["event.name"]).toBe("skill_invoked")
    expect(record.attributes?.["skill_name"]).toBe("review")
    expect(record.attributes?.["arguments_length"]).toBe("sensitive prompt text".length)
    expect(record.attributes?.["arguments"]).toBeUndefined()
    expect(record.attributes?.["description"]).toBe("Review the current diff")
  })

  test("does nothing when command is not a skill", async () => {
    const { ctx, counters, logger } = makeCtx("proj_test")

    await handleCommandExecuteBefore(commandInput("plain"), ctx, async () => undefined)

    expect(counters.skill.calls).toHaveLength(0)
    expect(logger.records).toHaveLength(0)
  })

  test("still emits log when skill.count is disabled", async () => {
    const { ctx, counters, logger } = makeCtx("proj_test", ["skill.count"])

    await handleCommandExecuteBefore(commandInput(), ctx, async () => ({ name: "review" }))

    expect(counters.skill.calls).toHaveLength(0)
    expect(logger.records.at(0)!.body).toBe("skill_invoked")
  })
})

describe("createSkillCommandResolver", () => {
  test("resolves commands marked with source skill from the command catalog", async () => {
    const client = {
      command: {
        async list() {
          return {
            data: [
              { name: "review", source: "skill", agent: "build", subtask: false },
              { name: "plain", source: "command" },
            ],
          }
        },
      },
    }
    const pluginLogs: Array<{ level: string; message: string; extra?: Record<string, unknown> }> = []
    const resolver = createSkillCommandResolver({
      client,
      serverUrl: new URL("http://127.0.0.1:40999"),
      directory: "/repo",
      log: async (level, message, extra) => { pluginLogs.push({ level, message, extra }) },
    })

    await resolver.refresh(true)

    expect(await resolver.resolve("review")).toEqual({ name: "review", agent: "build", subtask: false })
    expect(await resolver.resolve("plain")).toBeUndefined()
    expect(pluginLogs.at(-1)?.extra?.["count"]).toBe(1)
  })

  test("falls back to raw /command catalog when client catalog lacks source metadata", async () => {
    const client = {
      command: {
        async list() {
          return {
            data: [
              { name: "review" },
            ],
          }
        },
      },
    }
    const requests: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requests.push(input instanceof Request ? input.url : String(input))
      return new Response(JSON.stringify([
        { name: "review", source: "skill", agent: "build" },
      ]), { status: 200, headers: { "content-type": "application/json" } })
    }) as unknown as typeof fetch
    try {
      const resolver = createSkillCommandResolver({
        client,
        serverUrl: new URL("http://127.0.0.1:40999"),
        directory: "/repo",
        log: async () => {},
      })

      await resolver.refresh(true)

      expect(requests).toHaveLength(1)
      expect(new URL(requests[0]!).pathname).toBe("/command")
      expect(new URL(requests[0]!).searchParams.get("directory")).toBe("/repo")
      expect(await resolver.resolve("review")).toEqual({ name: "review", agent: "build" })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("preserves cached skills when catalog refresh fails", async () => {
    let failClient = false
    const client = {
      command: {
        async list() {
          if (failClient) return { error: "unavailable" }
          return {
            data: [
              { name: "review", source: "skill" },
            ],
          }
        },
      },
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("unavailable", { status: 500 })) as unknown as typeof fetch
    try {
      const resolver = createSkillCommandResolver({
        client,
        serverUrl: new URL("http://127.0.0.1:40999"),
        directory: "/repo",
        log: async () => {},
      })

      await resolver.refresh(true)
      expect(await resolver.resolve("review")).toEqual({ name: "review" })

      failClient = true
      await resolver.refresh(true)

      expect(await resolver.resolve("review")).toEqual({ name: "review" })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("preserves cached skills when client catalog lacks source metadata and raw lookups fail", async () => {
    let metadataLessClient = false
    const client = {
      command: {
        async list() {
          if (metadataLessClient) {
            return {
              data: [
                { name: "review" },
              ],
            }
          }
          return {
            data: [
              { name: "review", source: "skill" },
            ],
          }
        },
      },
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response("unavailable", { status: 500 })) as unknown as typeof fetch
    try {
      const resolver = createSkillCommandResolver({
        client,
        serverUrl: new URL("http://127.0.0.1:40999"),
        directory: "/repo",
        log: async () => {},
      })

      await resolver.refresh(true)
      expect(await resolver.resolve("review")).toEqual({ name: "review" })

      metadataLessClient = true
      await resolver.refresh(true)

      expect(await resolver.resolve("review")).toEqual({ name: "review" })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
