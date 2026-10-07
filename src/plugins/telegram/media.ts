import { Effect, Exit, Redacted } from "effect"
import { closeSync, constants, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeSync } from "node:fs"
import { extname, isAbsolute, join, resolve } from "node:path"
import { telegramApi, type Http } from "./http"

export type MediaMessage = {
  photo?: readonly { file_id: string; file_size?: number; width: number; height: number }[]
  document?: { file_id: string; file_name?: string; file_size?: number; mime_type?: string }
  caption?: string
}
const DOWNLOAD = 20_000_000
const UPLOAD = 50_000_000
class MediaError extends Error {}
const safeError = (error: unknown) => error instanceof MediaError ? error : new MediaError("Telegram media transfer failed")
const local = <A>(f: () => A) => Effect.try({ try: f, catch: safeError })
const sizeCheck = (size: number | undefined, limit: number) => {
  if (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > limit)) {
    throw new MediaError(`Telegram attachment exceeds the ${limit} byte limit or has invalid size`)
  }
}
const extension = (name = "") => {
  const ext = extname(name).toLowerCase()
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ".bin"
}

// Race even mocked/non-cooperative transports against cancellation; never retain their errors.
const pending = <A>(signal: AbortSignal, work: () => Promise<A>) => Effect.tryPromise({
  try: () => new Promise<A>((resolve, reject) => {
    const abort = () => reject(new MediaError("Telegram media transfer cancelled or timed out"))
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  }),
  catch: safeError,
})

export const telegramMedia = (token: Redacted.Redacted<string>, directory: string, http: Http = fetch) => {
  const api = telegramApi(token, http)
  const receive = (message: MediaMessage): Effect.Effect<string | undefined, Error> => Effect.scoped(Effect.gen(function* () {
    const photo = message.photo?.reduce<NonNullable<MediaMessage["photo"]>[number] | undefined>((best, next) => !best || next.width * next.height > best.width * best.height ? next : best, undefined)
    const attachment = photo ?? message.document
    if (!attachment) return undefined
    yield* local(() => sizeCheck(attachment.file_size, DOWNLOAD))

    const file = yield* api.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: attachment.file_id })
    yield* local(() => {
      sizeCheck(file?.file_size, DOWNLOAD)
      if (typeof file?.file_path !== "string" || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(file.file_path)
        || file.file_path.split("/").some((part) => part === "." || part === "..")) {
        throw new MediaError("Telegram returned an unsupported file path")
      }
    })
    const scratch = yield* Effect.acquireRelease(local(() => {
      const root = resolve(directory)
      if (/[\x00-\x1f\x7f'"\\$`]/.test(root)) throw new MediaError("Unsupported media directory")
      mkdirSync(root, { recursive: true, mode: 0o700 })
      const canonical = realpathSync(root)
      if (/[\x00-\x1f\x7f'"\\$`]/.test(canonical)) throw new MediaError("Unsupported media directory")
      return mkdtempSync(join(canonical, "attachment-"))
    }), (path, exit) => Exit.isFailure(exit) ? Effect.sync(() => rmSync(path, { recursive: true, force: true })) : Effect.void)
    const path = join(scratch, `file${photo ? ".jpg" : extension(message.document?.file_name)}`)
    const fd = yield* Effect.acquireRelease(local(() => openSync(path, "wx", 0o600)), (fd) => Effect.sync(() => closeSync(fd)))
    const controller = yield* Effect.acquireRelease(Effect.sync(() => new AbortController()), (c) => Effect.sync(() => c.abort()))
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(40_000)])
    const response = yield* pending(signal, () => http(`https://api.telegram.org/file/bot${Redacted.value(token)}/${file.file_path}`, {
      method: "GET", redirect: "error", signal,
    }).then((download) => {
      // Interruption can happen before the reader's scoped cleanup is installed.
      // A locked body belongs to that reader; otherwise cancel it here.
      const cancelBody = () => {
        if (download.body && !download.body.locked) {
          void download.body.cancel().catch(() => {})
        }
      }

      if (signal.aborted) cancelBody()
      else signal.addEventListener("abort", cancelBody, { once: true })

      return download
    }))
    const reader = yield* Effect.acquireRelease(local(() => {
      if (!response.body) throw new MediaError("Telegram download returned no file")
      return response.body.getReader()
    }), (reader) => Effect.sync(() => { void reader.cancel().catch(() => {}) }))
    yield* local(() => {
      if (!response.ok) throw new MediaError(`Telegram download failed (${response.status})`)
      const length = response.headers.get("content-length")
      if (length !== null) sizeCheck(Number(length), DOWNLOAD)
    })
    let total = 0

    while (true) {
      const chunk = yield* pending(signal, () => reader.read())
      if (chunk.done) break
      total += chunk.value.byteLength
      yield* local(() => {
        sizeCheck(total, DOWNLOAD)
        let offset = 0

        while (offset < chunk.value.byteLength) {
          const written = writeSync(fd, chunk.value, offset, chunk.value.byteLength - offset)
          if (!written) throw new MediaError("Unable to save Telegram attachment")
          offset += written
        }
      })
    }

    return `${message.caption ? `${message.caption}\n` : ""}'${path}'`
  }))

  const send = (path: string, chatId: string, caption?: string): Effect.Effect<void, Error> => Effect.scoped(Effect.gen(function* () {
    const fd = yield* Effect.acquireRelease(local(() => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.includes("\0")) throw new MediaError("A local file path is required")
      return openSync(isAbsolute(path) ? path : resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    }), (fd) => Effect.sync(() => closeSync(fd)))
    const bytes = yield* local(() => {
      const stat = fstatSync(fd)
      if (!stat.isFile()) throw new MediaError("Only regular local files can be sent")
      sizeCheck(stat.size, UPLOAD)
      const chunks: Uint8Array<ArrayBuffer>[] = []
      let total = 0

      while (true) {
        const chunk = new Uint8Array(Math.min(64 * 1024, UPLOAD - total + 1))
        const count = readSync(fd, chunk)
        if (!count) break
        total += count
        sizeCheck(total, UPLOAD)
        chunks.push(chunk.subarray(0, count))
      }

      return chunks
    })
    const body = new FormData()
    body.set("chat_id", chatId)
    if (caption !== undefined) body.set("caption", caption)
    body.set("document", new Blob(bytes), `file${extension(path)}`)
    yield* api.call("sendDocument", body)
  }))

  return { receive, send }
}
