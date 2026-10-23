import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname } from "node:path"
import { Data, Effect } from "effect"
import type { ConfigSchema } from "./config"

// Voice through an OpenAI-compatible API (KTD25): a voice note to text, a reply to speech. What is sent goes to the
// third-party API config.json's media section names; its key is read from the environment, never stored.
export type MediaSettings = typeof ConfigSchema.Type["media"]
export type Http = (url: string, init: RequestInit) => Promise<Response>
export class MediaError extends Data.TaggedError("MediaError")<{ message: string }> {}

export const makeMedia = (settings: MediaSettings, http: Http = fetch) => {
  const post = (path: string, body: FormData | string) => Effect.gen(function* () {
    const key = process.env[settings.apiKeyEnv]
    if (!key) return yield* new MediaError({ message: `voice needs an API key in ${settings.apiKeyEnv} (config.json's media.apiKeyEnv names it)` })

    const headers: Record<string, string> = { authorization: `Bearer ${key}`, ...(typeof body === "string" ? { "content-type": "application/json" } : {}) }
    const response = yield* Effect.tryPromise({
      try: (signal) => http(`${settings.baseUrl}${path}`, { method: "POST", headers, body, signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) }),
      catch: () => new MediaError({ message: `the media API could not be reached (${settings.baseUrl})` }),
    })
    // A transcription refused here is often the format: Telegram's OGG is sent as is (KTD25).
    if (!response.ok) return yield* new MediaError({ message: `the media API refused the request (${response.status})` })
    return response
  })
  const read = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: () => new MediaError({ message: "the media API's reply was unreadable" }) })

  const transcribe = (path: string) => Effect.gen(function* () {
    const bytes = yield* Effect.try({ try: () => readFileSync(path), catch: () => new MediaError({ message: "the voice note could not be read" }) })
    const form = new FormData()
    form.set("model", settings.transcribeModel)
    form.set("file", new Blob([bytes]), basename(path))

    const response = yield* post("/audio/transcriptions", form)
    const reply = yield* read(() => response.json() as Promise<{ text?: unknown }>)
    if (typeof reply?.text !== "string" || !reply.text.trim()) return yield* new MediaError({ message: "no speech was recognised" })
    return reply.text.trim()
  })

  // ponytail: input over the API's 4096 characters is cut; chunk and join clips if long spoken replies matter.
  const speak = (text: string, path: string) => Effect.gen(function* () {
    const body = JSON.stringify({ model: settings.speechModel, voice: settings.voice, input: text.slice(0, 4096), response_format: "opus" })
    const response = yield* post("/audio/speech", body)
    const audio = yield* read(() => response.arrayBuffer())

    yield* Effect.try({
      try: () => { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, new Uint8Array(audio), { mode: 0o600 }) },
      catch: () => new MediaError({ message: "the spoken reply could not be saved" }),
    })
    return path
  })

  return { transcribe, speak }
}
