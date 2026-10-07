import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Redacted, Semaphore } from "effect"
import { Channel, PluginError } from "empty-vessel"
import { telegramApi, splitText, type Http } from "./http"
import { hash, lockBot, openState } from "./state"
import { telegramMedia } from "./media"

export type TelegramOptions = {
  token: Redacted.Redacted<string>
  allowedUserId: string
  allowedChatId: string
  stateDirectory?: string
}
export type TelegramDependencies = { http?: Http; home?: string; project?: string; sendIntervalMs?: number }
type Update = { update_id: number; message?: {
  text?: string; caption?: string
  photo?: ReadonlyArray<{ file_id: string; file_size?: number; width: number; height: number }>
  document?: { file_id: string; file_name?: string; file_size?: number; mime_type?: string }
  from?: { id: number; is_bot?: boolean }; chat?: { id: number; type: string }
} }

export const makeTelegramChannel = (options: TelegramOptions, dependencies: TelegramDependencies = {}) => Effect.gen(function* () {
  if (!/^[1-9]\d*$/.test(options.allowedUserId) || !/^[1-9]\d*$/.test(options.allowedChatId)) {
    return yield* Effect.fail(new Error("Telegram requires positive private user and chat IDs"))
  }

  const home = dependencies.home ?? (process.env.EMPTY_VESSEL_HOME || join(homedir(), ".empty-vessel"))
  const api = telegramApi(options.token, dependencies.http)
  const media = telegramMedia(options.token, join(home, "telegram", "attachments"), dependencies.http)
  const bot = yield* api.call<{ id: number; is_bot: boolean }>("getMe")
  if (!Number.isSafeInteger(bot?.id) || bot.id <= 0 || bot.is_bot !== true) {
    return yield* Effect.fail(new Error("Telegram bot identity invalid"))
  }

  yield* lockBot(home, bot.id)
  const webhook = yield* api.call<{ url: string }>("getWebhookInfo")
  if (typeof webhook?.url !== "string" || webhook.url !== "") {
    return yield* Effect.fail(new Error("Telegram webhook configured or invalid; remove it explicitly before polling"))
  }

  const state = yield* openState(options.stateDirectory ?? join(home, "telegram", "state"),
    hash(Redacted.value(options.token)), options.allowedChatId, dependencies.project ?? process.cwd())
  const sending = yield* Semaphore.make(1)
  const listening = yield* Semaphore.make(1)
  let lastSend = 0
  let progressMessage: { id: number; text: string } | undefined

  const send = (text: string) => sending.withPermits(1)(Effect.gen(function* () {
    progressMessage = undefined

    for (const chunk of splitText(text)) {
      const wait = (dependencies.sendIntervalMs ?? 1100) - (Date.now() - lastSend)
      if (wait > 0) yield* Effect.sleep(wait)
      yield* api.call("sendMessage", { chat_id: options.allowedChatId, text: chunk }).pipe(
        Effect.ensuring(Effect.sync(() => { lastSend = Date.now() })),
      )
    }
  }))

  const sendFile = (path: string, caption?: string) => sending.withPermits(1)(Effect.gen(function* () {
    progressMessage = undefined
    const wait = (dependencies.sendIntervalMs ?? 1100) - (Date.now() - lastSend)
    if (wait > 0) yield* Effect.sleep(wait)

    yield* media.send(path, options.allowedChatId, caption).pipe(
      Effect.ensuring(Effect.sync(() => { lastSend = Date.now() })),
    )
  }))

  const appendProgress = (chunk: string) => Effect.gen(function* () {
    const combined = progressMessage ? `${progressMessage.text}\n${chunk}` : chunk
    const append = progressMessage && combined.length <= 4096
    const text = append ? combined : chunk
    const wait = (dependencies.sendIntervalMs ?? 1100) - (Date.now() - lastSend)
    if (wait > 0) yield* Effect.sleep(wait)

    if (append && progressMessage) {
      yield* api.call("editMessageText", {
        chat_id: options.allowedChatId, message_id: progressMessage.id, text,
      }).pipe(Effect.ensuring(Effect.sync(() => { lastSend = Date.now() })))
      progressMessage.text = text
    } else {
      const message = yield* api.call<{ message_id: number }>("sendMessage", {
        chat_id: options.allowedChatId, text, disable_notification: true,
      }).pipe(Effect.ensuring(Effect.sync(() => { lastSend = Date.now() })))
      if (!Number.isSafeInteger(message?.message_id) || message.message_id <= 0) {
        return yield* Effect.fail(new Error("Telegram progress message ID invalid"))
      }

      progressMessage = { id: message.message_id, text }
    }
  })

  let lastSummary: string | undefined
  const progress = (summary: string) => sending.withPermits(1)(Effect.gen(function* () {
    if (!summary || (progressMessage && lastSummary === summary)) return

    for (const chunk of splitText(summary)) {
      yield* appendProgress(chunk)
    }

    lastSummary = summary
  }))

  const listen = (onMessage: (text: string) => Effect.Effect<void>) => listening.withPermits(1)(Effect.gen(function* () {
    while (true) {
      const updates = yield* api.call<Update[]>("getUpdates", {
        offset: state.get().offset, timeout: 25, allowed_updates: ["message"],
      })
      if (!Array.isArray(updates)) return yield* Effect.fail(new Error("Telegram updates invalid"))

      for (const update of updates) {
        if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0 || update.update_id >= Number.MAX_SAFE_INTEGER) {
          return yield* Effect.fail(new Error("Telegram update ID invalid"))
        }
        if (update.update_id < state.get().offset) continue

        // Persist BEFORE enqueueing: a crash may lose a message, but cannot auto-replay an uncertain execution.
        yield* state.save({ offset: update.update_id + 1 })
        const message = update.message
        if (message?.chat?.type !== "private" || String(message.chat.id) !== options.allowedChatId ||
          !message.from || message.from.is_bot !== false || String(message.from.id) !== options.allowedUserId) continue

        if (message.photo || message.document) {
          const attached = yield* media.receive(message).pipe(Effect.catch(() =>
            send("Could not receive attachment. Try a smaller photo or document (up to 20 MB).").pipe(Effect.as(undefined)),
          ))
          // Captions are prompts, never host commands such as /stop or !shell.
          if (attached) yield* onMessage(`Attachment received:\n${attached}`)
        } else if (typeof message.text === "string" && message.text.length > 0) {
          yield* onMessage(message.text)
        }
      }
      // Telegram normally holds empty polls; also avoid spinning on an unexpectedly immediate response.
      if (updates.length === 0) yield* Effect.sleep(100)
    }
  }))

  return Channel.of({
    hideUsageSummaries: true,
    loadSession: Effect.sync(() => state.get().session),
    saveSession: (session) => state.save({ session }),
    send, sendFile, progress, listen,
  })
})

export const telegramLayer = (options: TelegramOptions, dependencies: TelegramDependencies = {}) =>
  Layer.effect(Channel, makeTelegramChannel(options, dependencies).pipe(
    Effect.mapError(() => new PluginError({ what: "telegram channel", message: "Telegram startup failed; check credentials, webhook, state directory and bot lock" })),
  ))
