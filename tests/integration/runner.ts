import { OpenCode, Model, Provider } from "@opencode/sdk"
import plugin from "../../src/index.ts"
import { acquireTracingState, flushSharedOtel } from "../../src/state.ts"

const directory = process.env["INTEGRATION_PROJECT"]!
const providerID = Provider.ID.make("integration")
const modelID = Model.ID.make("scripted")
const model = Model.Info.default(providerID, modelID)
const toolMode = process.env["INTEGRATION_SCENARIO"] === "read"

await using host = await OpenCode.create({
  database: { path: `${directory}/opencode.db` },
  models: { fetch: false, snapshot: false },
  config: { project: false, directory: `${directory}/config`, content: "{}" },
  fs: { filewatcher: false, fff: false },
  plugins: [
    {
      id: "integration.fixtures",
      async setup(ctx) {
        await ctx.provider.transform(editor => editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            activation: "enabled",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: process.env["INTEGRATION_MODEL_URL"]! },
          },
          models: [model],
        }))
        await ctx.session.hook("title", event => { event.result = "Integration fixture" })
        await ctx.session.hook("context", event => {
          for (const name of Object.keys(event.tools)) {
            if (!toolMode || name !== "read") delete event.tools[name]
          }
        })
      },
    },
    plugin,
  ],
})

const session = await host.sessions.create({
  location: { directory },
  model: { providerID, id: modelID },
  title: "Integration fixture",
})
await host.sessions.prompt({ sessionID: session.id, text: "Read fixture.txt and report its contents." })
await host.sessions.wait({ sessionID: session.id })
await acquireTracingState().eventQueue
const messages = await host.sessions.context({ sessionID: session.id })
if (!messages.some(message => message.type === "idle" && message.outcome === "succeeded")) {
  throw new Error(`Session did not succeed: ${JSON.stringify(messages)}`)
}
await host.close()
await flushSharedOtel()
await Bun.write(`${directory}/result.json`, JSON.stringify({ sessionID: session.id, messages }))
