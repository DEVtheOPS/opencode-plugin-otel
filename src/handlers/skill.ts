import { isMetricEnabled } from "../util.ts"
import type { HandlerContext, PluginLogger } from "../types.ts"

type SkillCommandInfo = {
  name: string
  description?: string
  agent?: string
  subtask?: boolean
}

type RawCommand = {
  name?: unknown
  source?: unknown
  description?: unknown
  agent?: unknown
  subtask?: unknown
}

type CommandListClient = {
  command?: {
    list(options?: { query?: { directory?: string; workspace?: string } }): Promise<{ data?: unknown; error?: unknown } | unknown>
  }
}

type CommandExecuteInput = {
  command: string
  sessionID: string
  arguments: string
}

type SkillInvocationInput = {
  sessionID: string
  skillName: string
  invocationType: "command" | "tool"
  commandName?: string
  toolName?: string
  argumentsLength?: number
  description?: string
  agent?: string
  subtask?: boolean
}

type SkillCommandLookup = {
  ok: boolean
  commands: SkillCommandInfo[]
}

type ParsedSkillCommands = {
  sourceAware: boolean
  commands: SkillCommandInfo[]
}

function rawSkillCommand(command: RawCommand): SkillCommandInfo | undefined {
  if (command.source !== "skill" || typeof command.name !== "string") return undefined
  return {
    name: command.name,
    ...(typeof command.description === "string" ? { description: command.description } : {}),
    ...(typeof command.agent === "string" ? { agent: command.agent } : {}),
    ...(typeof command.subtask === "boolean" ? { subtask: command.subtask } : {}),
  }
}

function commandsFromPayload(payload: unknown): ParsedSkillCommands {
  const data = payload && typeof payload === "object" && "data" in payload
    ? (payload as { data?: unknown }).data
    : payload
  const commands = data && typeof data === "object" && "data" in data
    ? (data as { data?: unknown }).data
    : data
  if (!Array.isArray(commands)) return { sourceAware: false, commands: [] }
  return {
    sourceAware: commands.length === 0
      || commands.some((command) => command && typeof command === "object" && "source" in command),
    commands: commands
      .map((command) => rawSkillCommand(command as RawCommand))
      .filter((command): command is SkillCommandInfo => !!command),
  }
}

async function clientSkillCommands(client: CommandListClient, directory: string | undefined): Promise<SkillCommandLookup> {
  if (!client.command?.list) return { ok: false, commands: [] }
  const response = await client.command.list(directory ? { query: { directory } } : undefined)
  if (response && typeof response === "object" && "error" in response && (response as { error?: unknown }).error !== undefined) {
    return { ok: false, commands: [] }
  }
  const parsed = commandsFromPayload(response)
  return { ok: parsed.sourceAware, commands: parsed.commands }
}

async function rawSkillCommands(serverUrl: URL, directory: string | undefined, path: "/command" | "/api/command"): Promise<SkillCommandLookup> {
  const url = new URL(path, serverUrl)
  if (directory) {
    if (path === "/api/command") {
      url.searchParams.set("location[directory]", directory)
    } else {
      url.searchParams.set("directory", directory)
    }
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1_000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return { ok: false, commands: [] }
    const parsed = commandsFromPayload(await response.json())
    return { ok: parsed.sourceAware, commands: parsed.commands }
  } finally {
    clearTimeout(timeout)
  }
}

export function createSkillCommandResolver(input: {
  client: CommandListClient
  serverUrl: URL
  directory?: string
  log: PluginLogger
}) {
  let lastRefresh = 0
  let refreshPromise: Promise<void> | undefined
  const skillCommands = new Map<string, SkillCommandInfo>()

  const refresh = async (force = false) => {
    if (!force && Date.now() - lastRefresh < 30_000) return
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
      const next = new Map<string, SkillCommandInfo>()
      let catalogLoaded = false
      try {
        const lookup = await clientSkillCommands(input.client, input.directory)
        catalogLoaded = catalogLoaded || lookup.ok
        for (const command of lookup.commands) {
          next.set(command.name, command)
        }
      } catch (err) {
        await input.log("debug", "otel: command catalog lookup failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      if (next.size === 0) {
        try {
          const lookup = await rawSkillCommands(input.serverUrl, input.directory, "/command")
          catalogLoaded = catalogLoaded || lookup.ok
          for (const command of lookup.commands) {
            next.set(command.name, command)
          }
        } catch (err) {
          await input.log("debug", "otel: raw command catalog lookup failed", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (next.size === 0) {
        try {
          const lookup = await rawSkillCommands(input.serverUrl, input.directory, "/api/command")
          catalogLoaded = catalogLoaded || lookup.ok
          for (const command of lookup.commands) {
            next.set(command.name, command)
          }
        } catch (err) {
          await input.log("debug", "otel: v2 command catalog lookup failed", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (!catalogLoaded) {
        await input.log("debug", "otel: skill command catalog refresh skipped")
        return
      }
      skillCommands.clear()
      for (const [name, command] of next) skillCommands.set(name, command)
      lastRefresh = Date.now()
      await input.log("debug", "otel: skill command catalog refreshed", { count: skillCommands.size })
    })().finally(() => {
      refreshPromise = undefined
    })
    return refreshPromise
  }

  return {
    refresh,
    resolve: async (command: string) => {
      let skill = skillCommands.get(command)
      if (skill) return skill
      await refresh(false)
      skill = skillCommands.get(command)
      return skill
    },
  }
}

function stringProp(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

/** Extracts a skill name from the native `skill` tool input without exposing raw input. */
export function skillNameFromToolInput(input: unknown): string {
  if (typeof input === "string" && input.trim()) return input
  if (!input || typeof input !== "object") return "unknown"
  const record = input as Record<string, unknown>
  const direct = stringProp(record, "skill") ?? stringProp(record, "skillName") ?? stringProp(record, "name")
  if (direct) return direct
  const skill = record.skill
  if (skill && typeof skill === "object") {
    return stringProp(skill as Record<string, unknown>, "name") ?? "unknown"
  }
  return "unknown"
}

/** Emits the shared skill usage metric and log event for command and native tool paths. */
export function recordSkillInvocation(input: SkillInvocationInput, ctx: HandlerContext) {
  const attrs = {
    ...ctx.commonAttrs,
    "session.id": input.sessionID,
    skill_name: input.skillName,
    invocation_type: input.invocationType,
    ...(input.commandName ? { command_name: input.commandName } : {}),
    ...(input.toolName ? { tool_name: input.toolName } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.subtask !== undefined ? { subtask: input.subtask } : {}),
  }

  if (isMetricEnabled("skill.count", ctx)) {
    ctx.instruments.skillCounter.add(1, attrs)
  }

  ctx.emitLog({
    severityNumber: ctx.logSeverity.info,
    severityText: "INFO",
    timestamp: Date.now(),
    observedTimestamp: Date.now(),
    body: "skill_invoked",
    attributes: {
      "event.name": "skill_invoked",
      ...attrs,
      ...(input.argumentsLength !== undefined ? { arguments_length: input.argumentsLength } : {}),
      ...(input.description ? { description: input.description } : {}),
    },
  })

  return ctx.log("info", "otel: skill_invoked", {
    sessionID: input.sessionID,
    skill_name: input.skillName,
    invocation_type: input.invocationType,
    ...(input.commandName ? { command_name: input.commandName } : {}),
    ...(input.toolName ? { tool_name: input.toolName } : {}),
  })
}

export async function handleCommandExecuteBefore(
  input: CommandExecuteInput,
  ctx: HandlerContext,
  resolveSkillCommand: (command: string) => Promise<SkillCommandInfo | undefined>,
) {
  const skill = await resolveSkillCommand(input.command)
  if (!skill) return

  return recordSkillInvocation({
    sessionID: input.sessionID,
    skillName: skill.name,
    invocationType: "command",
    commandName: input.command,
    argumentsLength: input.arguments.length,
    ...(skill.description ? { description: skill.description } : {}),
    ...(skill.agent ? { agent: skill.agent } : {}),
    ...(skill.subtask !== undefined ? { subtask: skill.subtask } : {}),
  }, ctx)
}
