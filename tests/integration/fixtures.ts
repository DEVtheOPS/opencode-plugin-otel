import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Payload = { [key: string]: Json }

export async function runScenario(scenario: "text" | "read", disabledTraces = "") {
  const directory = await mkdtemp(join(tmpdir(), "opencode-otel-integration-"))
  const requests: Payload[] = []
  const received: Record<string, Payload[]> = { traces: [], metrics: [], logs: [] }
  const failures: string[] = []
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const signal = new URL(request.url).pathname.replace("/v1/", "")
      if (request.method !== "POST" || !received[signal]) return new Response(null, { status: 404 })
      try {
        received[signal].push(await request.json() as Payload)
        return Response.json({})
      } catch (error) {
        failures.push(String(error))
        return new Response(null, { status: 400 })
      }
    },
  })
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
      const body = await request.json() as Payload
      requests.push(body)
      if (requests.length > 3) return Response.json({ error: { message: "Unexpected model request" } }, { status: 400 })
      const messages = body["messages"] as Payload[]
      const hasToolResult = messages.some(message => message["role"] === "tool")
      const tools = body["tools"] as Payload[] | undefined
      const wantsRead = scenario === "read" && !hasToolResult
      if (wantsRead && !tools?.some(tool => (tool["function"] as Payload)["name"] === "read")) {
        failures.push("OpenCode did not expose the read tool")
        return Response.json({ error: { message: failures.at(-1) } }, { status: 400 })
      }
      const chunk = (delta: Payload, finish: string | null = null, usage?: Payload) => ({
        id: "chatcmpl-integration",
        object: "chat.completion.chunk",
        created: 1,
        model: "scripted",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      })
      const delta: Payload = wantsRead
        ? { tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: join(directory, "fixture.txt") }) } }] }
        : { content: "Fixture complete." }
      const chunks = [
        chunk({ role: "assistant" }),
        chunk(delta),
        chunk({}, wantsRead ? "tool_calls" : "stop", { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 }),
      ]
      return new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    await mkdir(join(directory, "config"))
    await writeFile(join(directory, "fixture.txt"), "integration-fixture-contents\n".repeat(256))
    const env: Record<string, string> = {}
    for (const key of ["PATH", "SystemRoot", "TMPDIR", "TEMP", "TMP"]) {
      if (process.env[key]) env[key] = process.env[key]!
    }
    Object.assign(env, {
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_DATA_HOME: join(directory, "data"),
      XDG_CACHE_HOME: join(directory, "cache"),
      XDG_STATE_HOME: join(directory, "state"),
      INTEGRATION_PROJECT: directory,
      INTEGRATION_SCENARIO: scenario,
      INTEGRATION_MODEL_URL: `${provider.url}v1`,
      OPENCODE_ENABLE_TELEMETRY: "1",
      OPENCODE_OTLP_ENDPOINT: String(receiver.url),
      OPENCODE_OTLP_PROTOCOL: "http/json",
      OPENCODE_DISABLE_TRACES: disabledTraces,
    })
    const git = Bun.spawnSync(["git", "init", "--quiet", directory], { env })
    if (git.exitCode !== 0) throw new Error(git.stderr.toString())
    child = Bun.spawn([process.execPath, join(import.meta.dir, "runner.ts")], {
      cwd: directory,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    timer = setTimeout(() => { timedOut = true; child?.kill() }, 30_000)
    const [code, output, errors] = await Promise.all([child.exited, stdout, stderr])
    if (timedOut || code !== 0 || failures.length) {
      throw new Error(JSON.stringify({ timedOut, code, output, errors, failures, requests, received }, null, 2))
    }
    try {
      const result = JSON.parse(await readFile(join(directory, "result.json"), "utf8")) as Payload
      return { received, requests, result, output, errors }
    } catch (error) {
      throw new Error(JSON.stringify({ error: String(error), output, errors, requests, received }, null, 2))
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (child) { child.kill(); await child.exited }
    provider.stop(true)
    receiver.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}
