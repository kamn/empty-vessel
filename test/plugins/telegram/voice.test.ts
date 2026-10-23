import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Redacted } from "effect"
import { makeTelegramChannel } from "../../../src/plugins/telegram"
import type { Http } from "../../../src/plugins/telegram/http"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const options = { token: Redacted.make("123:fake-test-only"), allowedUserId: "42", allowedChatId: "42" }
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }))
const update = (update_id: number, content: object) => ({ update_id, message: {
  message_id: update_id, from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, ...content,
} })
const voice = { file_id: "voice", duration: 2, mime_type: "audio/ogg", file_size: 4 }

const transport = (batches: unknown[][]) => {
  const calls: { method: string; body: any }[] = []
  const http: Http = async (url, init) => {
    const method = url.includes("/file/bot") ? "download" : url.split("/").at(-1)!
    calls.push({ method, body: init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : undefined })

    if (method === "getMe") return ok({ id: 123, is_bot: true })
    if (method === "getWebhookInfo") return ok({ url: "" })
    if (method === "getUpdates") return batches.length ? ok(batches.shift()) : new Response(JSON.stringify({ ok: false, error_code: 401 }), { status: 401 })
    if (method === "getFile") return ok({ file_path: "voice/file_1.oga", file_size: 4 })
    if (method === "download") return new Response("OggS")
    return ok({ message_id: calls.length })
  }
  return { http, calls }
}
const listen = (batches: unknown[][], transcribe?: (path: string) => Effect.Effect<string, Error>) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "empty-vessel-voice-")))
  roots.push(home)
  const mock = transport(batches)
  const seen: { text: string; requestId?: string; voice?: true }[] = []
  const heard: string[] = []
  const channel = yield* makeTelegramChannel(options, { home, project: home, sendIntervalMs: 0, http: mock.http,
    ...(transcribe ? { transcribe: (path: string) => { heard.push(readFileSync(path, "utf8")); return transcribe(path) } } : {}) })
  yield* channel.listen((message) => Effect.sync(() => { seen.push(message) })).pipe(Effect.exit)
  return { ...mock, seen, heard, channel, home }
})))
const replies = (calls: { method: string; body: any }[]) => calls.filter((c) => c.method === "sendMessage").map((c) => c.body.text as string)

test("a voice note is downloaded, transcribed as the OGG it is, and handled as text with the voice flag", async () => {
  const result = await listen([[update(1, { voice }), update(2, { audio: { file_id: "audio", duration: 3, file_name: "memo.mp3" } })]], () => Effect.succeed("turn on the lights"))
  expect(result.heard).toEqual(["OggS", "OggS"])
  expect(result.seen).toEqual([
    { text: "turn on the lights", requestId: "tg:42:1", voice: true },
    { text: "turn on the lights", requestId: "tg:42:2", voice: true },
  ])
})

test("a failing transcriber gets a clear reply, nothing is submitted, and the next text still runs", async () => {
  const result = await listen([[update(1, { voice }), update(2, { text: "next survives" })]], () => Effect.fail(new Error("The media API refused the request (400)")))
  expect(result.seen).toEqual([{ text: "next survives", requestId: "tg:42:2" }])
  expect(replies(result.calls)).toEqual(["Could not use the voice note: The media API refused the request (400)"])
  expect(result.calls.filter((c) => c.method === "getUpdates").at(-1)!.body.offset).toBe(3)
})

test("without a transcriber, a voice note says voice isn't set up instead of being dropped", async () => {
  const result = await listen([[update(1, { voice })]])
  expect(result.seen).toEqual([])
  expect(replies(result.calls)[0]).toContain("not set up")
})

test("sendVoice uploads the opus file as a voice message with its caption", async () => {
  const result = await listen([])
  const path = join(result.home, "reply.ogg")
  writeFileSync(path, "opus")

  // The channel's scope closed with listen; sending needs none.
  expect(await Effect.runPromise(result.channel.sendVoice!(path, "AI-generated voice"))).toBeNumber()
  const sent = result.calls.find((c) => c.method === "sendVoice")!.body as FormData
  expect(sent.get("caption")).toBe("AI-generated voice")
  expect(await (sent.get("voice") as File).text()).toBe("opus")
})
