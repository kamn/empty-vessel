import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { makeCodexAsk, makeCodexFill, makeCodexSystemTwo } from "./codex"
import { settings } from "./config"
import { setup } from "./setup"
import { Config, type Plugin, PluginError, pluginSettings, SystemTwo } from "empty-vessel"

// Codex as System Two (with its Fill and Ask), on your ChatGPT plan.
export const codex: Plugin = {
  name: "codex",
  settings,
  setup,
  provides: {
    systemTwo: Effect.gen(function* () {
      const { systemTwo } = yield* Config
      const { model, fillModel } = yield* pluginSettings("codex", settings)
      const http = Layer.provide(FetchHttpClient.layer)

      return {
        systemTwo: makeCodexSystemTwo(model, systemTwo.reasoning, systemTwo.maxRounds, systemTwo.webSearch).pipe(http,
          Layer.catchTag("CodexAuthError", (e) => Layer.effect(SystemTwo, Effect.fail(new PluginError({ what: "codex login", message: e.message }))))),
        fill: makeCodexFill(fillModel).pipe(http),
        ask: makeCodexAsk(model, systemTwo.reasoning).pipe(http),
        describe: { long: `codex (${model}, ${systemTwo.reasoning} reasoning)`, short: `${model} (${systemTwo.reasoning})` },
      }
    }),
  },
}
