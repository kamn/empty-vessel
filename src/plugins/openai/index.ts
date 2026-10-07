import { Effect } from "effect"
import { Config, modelParts, type Plugin, pluginSettings } from "empty-vessel"
import { settings } from "./config"
import { openAIModel } from "./model"
import { setupAs } from "./setup"

// Any OpenAI-compatible Chat Completions API as System Two (with its Ask and Fill): the core's loop around one request.
// systemTwo.use: "openai", and plugins.openai.config: { baseUrl, model, fillModel?, apiKey? } (or EMPTY_VESSEL_OPENAI_API_KEY).
// openaiAs(name): another copy, with its settings in plugins.<name>.config (a section with from: "openai").
export const openaiAs = (name: string): Plugin => ({
  name,
  settings,
  setup: setupAs(name),
  provides: {
    systemTwo: Effect.gen(function* () {
      const { systemTwo } = yield* Config
      const { baseUrl, model, fillModel, apiKey } = yield* pluginSettings(name, settings)
      const main = openAIModel(baseUrl, model, apiKey)

      return { ...modelParts(main, fillModel ? openAIModel(baseUrl, fillModel, apiKey) : main, systemTwo.maxRounds), describe: { long: `${name} (${model} at ${baseUrl})`, short: model } }
    }),
  },
})

export const openai = openaiAs("openai")
