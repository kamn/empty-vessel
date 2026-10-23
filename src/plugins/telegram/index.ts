import { Effect } from "effect"
import { Config, makeMedia, type Plugin, pluginSettings } from "empty-vessel"
import { settings } from "./config"
import { setup } from "./setup"
import { telegramLayer } from "./channel"

export const telegram: Plugin = {
  name: "telegram", settings, setup,
  // Voice notes are transcribed with config.json's media settings.
  provides: { channel: Effect.gen(function* () {
    const options = yield* pluginSettings("telegram", settings)
    const config = yield* Config
    return telegramLayer(options, { transcribe: makeMedia(config.media).transcribe })
  }) },
}

export { telegramLayer, makeTelegramChannel, type TelegramOptions, type TelegramDependencies } from "./channel"
