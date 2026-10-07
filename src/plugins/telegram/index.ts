import { Effect } from "effect"
import { type Plugin, pluginSettings } from "empty-vessel"
import { settings } from "./config"
import { setup } from "./setup"
import { telegramLayer } from "./channel"

export const telegram: Plugin = {
  name: "telegram", settings, setup,
  provides: { channel: pluginSettings("telegram", settings).pipe(Effect.map(telegramLayer)) },
}

export { telegramLayer, makeTelegramChannel, type TelegramOptions, type TelegramDependencies } from "./channel"
