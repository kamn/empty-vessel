import { Effect, Redacted } from "effect"
import type { PluginSetup } from "empty-vessel"
import { telegramApi, type Http } from "./http"

export const tokenWorks = (token: string, http?: Http): Effect.Effect<boolean> =>
  telegramApi(Redacted.make(token), http).call<{ id: number; is_bot: boolean }>("getMe").pipe(
    Effect.map((bot) => Number.isSafeInteger(bot?.id) && bot.id > 0 && bot.is_bot === true),
    Effect.catch(() => Effect.succeed(false)),
  )
const validId = (value: string) => Effect.succeed(/^[1-9]\d*$/.test(value))

export const setup: PluginSetup = {
  name: "telegram", kind: "channel", title: "Telegram private bot chat",
  about: "Create a bot with BotFather. Supply your own user ID and private chat ID; group chats are not supported. Send /start to the bot first.",
  asks: [
    { setting: "token", prompt: "Telegram bot token", secret: true, test: (token) => tokenWorks(token), failed: "Bot token could not be validated" },
    { setting: "allowedUserId", prompt: "Your Telegram user ID", test: validId, failed: "Use a positive digit string" },
    { setting: "allowedChatId", prompt: "Your private Telegram chat ID", test: validId, failed: "Use a positive digit string" },
  ],
}
