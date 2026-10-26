import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Redacted, Semaphore } from "effect"
import { Channel, PluginError } from "empty-vessel"
import { telegramApi, splitText, TelegramError, type Http } from "./http"
import { telegramHtml } from "./format"
import { hash, lockBot, openState } from "./state"
import { telegramMedia } from "./media"

export type TelegramOptions = {
  token: Redacted.Redacted<string>
  allowedUserId: string
  allowedChatId: string
  stateDirectory?: string
}
// transcribe: a voice note's text (src/base/media.ts); without it, voice notes are answered that voice isn't set up.
export type TelegramDependencies = {
  http?: Http; home?: string; project?: string; sendIntervalMs?: number
  transcribe?: (path: string) => Effect.Effect<string, Error>
}
type Update = { update_id: number; message?: {
  message_id?: number; text?: string; caption?: string
  photo?: ReadonlyArray<{ file_id: string; file_size?: number; width: number; height: number }>
  document?: { file_id: string; file_name?: string; file_size?: number; mime_type?: string }
  voice?: { file_id: string; file_size?: number }; audio?: { file_id: string; file_name?: string; file_size?: number }
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
    let id: number | undefined

    for (const chunk of splitText(text)) {
      const wait = (dependencies.sendIntervalMs ?? 1100) - (Date.now() - lastSend)
      if (wait > 0) yield* Effect.sleep(wait)
      // Formatted when it fits; Telegram refusing the HTML (400) gets the same chunk as plain text.
      const plain = { chat_id: options.allowedChatId, text: chunk }
      const html = telegramHtml(chunk)
      const sent = yield* (html && html.length <= 4096
        ? api.call<{ message_id?: number }>("sendMessage", { ...plain, text: html, parse_mode: "HTML" }).pipe(
          Effect.catchIf(error => error instanceof TelegramError && error.status === 400, () => api.call<{ message_id?: number }>("sendMessage", plain)),
        )
        : api.call<{ message_id?: number }>("sendMessage", plain)).pipe(
        Effect.ensuring(Effect.sync(() => { lastSend = Date.now() })),
      )
      id = sent?.message_id
    }

    return id
  }))

  const upload = (as: "document" | "voice") => (path: string, caption?: string) => sending.withPermits(1)(Effect.gen(function* () {
    progressMessage = undefined
    const wait = (dependencies.sendIntervalMs ?? 1100) - (Date.now() - lastSend)
    if (wait > 0) yield* Effect.sleep(wait)

    return yield* media.send(path, options.allowedChatId, caption, as).pipe(
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

  // Outside the send pacing: a chat action is no message, and holding it behind a send would make it late.
  const typing = () => api.call("sendChatAction", { chat_id: options.allowedChatId, action: "typing" }).pipe(Effect.asVoid)

  // A voice note is handled as its text; one that can't be heard is answered, and nothing is submitted.
  const hear = (message: NonNullable<Update["message"]>) => Effect.gen(function* () {
    if (!dependencies.transcribe) return yield* Effect.fail(new Error("voice is not set up here"))
    const path = yield* media.download(message)
    return path === undefined ? undefined : yield* dependencies.transcribe(path)
  }).pipe(Effect.catch((error) => send(`Could not use the voice note: ${error.message}`).pipe(Effect.as(undefined))))

  const listen = (onMessage: (message: { text: string; requestId?: string; voice?: true }) => Effect.Effect<void>) => listening.withPermits(1)(Effect.gen(function* () {
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

        // The offset is saved only AFTER the message is handled: a crash before then redelivers it (same requestId),
        // and the receiver skips what it already handled (KTD12).
        const message = update.message
        if (message?.chat?.type === "private" && String(message.chat.id) === options.allowedChatId &&
          message.from && message.from.is_bot === false && String(message.from.id) === options.allowedUserId) {
          const requestId = Number.isSafeInteger(message.message_id) ? `tg:${options.allowedChatId}:${message.message_id}` : undefined

          if (message.voice || message.audio) {
            const text = yield* hear(message)
            if (text) yield* onMessage({ text, requestId, voice: true })
          } else if (message.photo || message.document) {
            const attached = yield* media.receive(message).pipe(Effect.catch(() =>
              send("Could not receive attachment. Try a smaller photo or document (up to 20 MB).").pipe(Effect.as(undefined)),
            ))
            // Captions are prompts, never host commands such as /stop or !shell.
            if (attached) yield* onMessage({ text: `Attachment received:\n${attached}`, requestId })
          } else if (typeof message.text === "string" && message.text.length > 0) {
            yield* onMessage({ text: message.text, requestId })
          }
        }

        yield* state.save({ offset: update.update_id + 1 })
      }
      // Telegram normally holds empty polls; also avoid spinning on an unexpectedly immediate response.
      if (updates.length === 0) yield* Effect.sleep(100)
    }
  }))

  return Channel.of({
    hideUsageSummaries: true,
    loadSession: Effect.sync(() => state.get().session),
    saveSession: (session) => state.save({ session }),
    send, sendFile: upload("document"), sendVoice: upload("voice"), progress, typing, listen,
  })
})

export const telegramLayer = (options: TelegramOptions, dependencies: TelegramDependencies = {}) =>
  Layer.effect(Channel, makeTelegramChannel(options, dependencies).pipe(
    Effect.mapError(() => new PluginError({ what: "telegram channel", message: "Telegram startup failed; check credentials, webhook, state directory and bot lock" })),
  ))
