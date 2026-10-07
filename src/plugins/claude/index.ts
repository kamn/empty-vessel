import { Effect } from "effect"
import { makeClaudeAsk, makeClaudeFill, makeClaudeSystemTwo } from "./claude"
import { settings } from "./config"
import { setup } from "./setup"
import { Config, type Plugin, pluginSettings } from "empty-vessel"

// Claude as System Two (with its Fill and Ask), through Claude Code.
export const claude: Plugin = {
  name: "claude",
  settings,
  setup,
  provides: {
    systemTwo: Effect.gen(function* () {
      const { systemTwo } = yield* Config
      const { model, fillModel } = yield* pluginSettings("claude", settings)

      return {
        systemTwo: makeClaudeSystemTwo(model, systemTwo.maxRounds, systemTwo.reasoning, undefined, undefined, systemTwo.webSearch),
        fill: makeClaudeFill(fillModel),
        ask: makeClaudeAsk(model, systemTwo.reasoning),
        describe: { long: `claude (${model ?? "Claude Code's default model"})`, short: `claude (${model ?? "default"})` },
      }
    }),
  },
}
