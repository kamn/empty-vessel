import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { ConfigSchema } from "../../src/base/config"
import { makeMedia, type Http } from "../../src/base/media"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "empty-vessel-media-")); roots.push(dir); return dir }
// The defaults, with a key variable only this test sets.
const settings = { ...Schema.decodeUnknownSync(ConfigSchema)({}).media, baseUrl: "https://media.test/v1", apiKeyEnv: "EV_MEDIA_TEST_KEY" }
process.env.EV_MEDIA_TEST_KEY = "sk-test-only"
const recording = (reply: () => Response) => {
  const calls: { url: string; init: RequestInit }[] = []
  const http: Http = async (url, init) => { calls.push({ url, init }); return reply() }
  return { http, calls }
}

test("defaults: voice is off, with today's model ids and the key read from OPENAI_API_KEY", () => {
  const media = Schema.decodeUnknownSync(ConfigSchema)({}).media
  expect(media).toEqual({ baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", transcribeModel: "gpt-transcribe", speechModel: "gpt-4o-mini-tts", voice: "marin", voiceReplies: "off" })
})

test("transcribe posts the OGG as is, multipart, with the model and the key", async () => {
  const dir = temp(), path = join(dir, "file.ogg")
  writeFileSync(path, "OggS fake opus")
  const mock = recording(() => Response.json({ text: "hello there" }))

  expect(await Effect.runPromise(makeMedia(settings, mock.http).transcribe(path))).toBe("hello there")
  const [call] = mock.calls
  expect(call!.url).toBe("https://media.test/v1/audio/transcriptions")
  expect((call!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-only")
  const form = call!.init.body as FormData
  expect(form.get("model")).toBe("gpt-transcribe")
  const file = form.get("file") as File
  expect(file.name).toBe("file.ogg")
  expect(await file.text()).toBe("OggS fake opus")
})

test("speak asks for opus with the voice, and saves the audio where it's told", async () => {
  const dir = temp(), path = join(dir, "voice", "run.ogg")
  const mock = recording(() => new Response("opus bytes"))

  expect(await Effect.runPromise(makeMedia(settings, mock.http).speak("Hi", path))).toBe(path)
  expect(readFileSync(path, "utf8")).toBe("opus bytes")
  expect(mock.calls[0]!.url).toBe("https://media.test/v1/audio/speech")
  expect(JSON.parse(String(mock.calls[0]!.init.body))).toEqual({ model: "gpt-4o-mini-tts", voice: "marin", input: "Hi", response_format: "opus" })
})

test("a missing key is a clear error, and nothing is sent", async () => {
  const mock = recording(() => Response.json({ text: "never" }))
  const media = makeMedia({ ...settings, apiKeyEnv: "EV_MEDIA_TEST_MISSING" }, mock.http)

  const error = await Effect.runPromise(Effect.flip(media.speak("Hi", join(temp(), "x.ogg"))))
  expect(error.message).toContain("EV_MEDIA_TEST_MISSING")
  expect(mock.calls).toHaveLength(0)
})

test("a refused request, an unreachable API and an empty transcript are clear errors", async () => {
  const dir = temp(), path = join(dir, "file.ogg")
  writeFileSync(path, "OggS")
  const run = (reply: () => Response) => Effect.runPromise(Effect.flip(makeMedia(settings, recording(reply).http).transcribe(path)))

  expect((await run(() => new Response("{}", { status: 400 }))).message).toContain("(400)")
  expect((await run(() => { throw new Error("offline") })).message).toContain("could not be reached")
  expect((await run(() => Response.json({ text: "  " }))).message).toContain("no speech")
})
