import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Redacted } from "effect"
import { imagesIn } from "../src/base/images"
import { makeTelegramChannel } from "../src/plugins/telegram"
import type { Http } from "../src/plugins/telegram/http"

const roots: string[] = []
const fixture = () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "empty-vessel-attachments-")))
  roots.push(home)
  return { home, project: home, sendIntervalMs: 0 }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const options = { token: Redacted.make("123:fake-test-only"), allowedUserId: "42", allowedChatId: "42" }
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAKUlEQVR4nGO4oKBANlJwuEA2Yhi1eNTiUYtHLR61eNTiUYtHLR45FgMADmuELvquDp8AAAAASUVORK5CYII=", "base64")
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }))
const unauthorized = () => new Response(JSON.stringify({ ok: false, error_code: 401 }), { status: 401 })
const photo = [{ file_id: "small", width: 10, height: 10 }, { file_id: "large", width: 40, height: 20 }]
const document = { file_id: "document", file_name: "screen shot.png", mime_type: "image/png" }
const update = (update_id: number, content: object) => ({ update_id, message: {
  from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, ...content,
} })

type Call = { method: string; body: any; at: number; init: RequestInit }
const transport = (batches: unknown[][], broken = false) => {
  const calls: Call[] = []
  const http: Http = async (url, init) => {
    const method = url.includes("/file/bot") ? "download" : url.split("/").at(-1)!
    const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, body, at: Date.now(), init })

    if (method === "getMe") return ok({ id: 123, is_bot: true })
    if (method === "getWebhookInfo") return ok({ url: "" })
    if (method === "getUpdates") return batches.length ? ok(batches.shift()) : unauthorized()
    if (method === "getFile") return ok({ file_path: body.file_id === "document" ? "documents/test.png" : "photos/test.jpg", file_size: bytes.length })
    if (method === "download") return broken ? new Response("secret upstream token 123:fake-test-only", { status: 404 }) : new Response(bytes)
    if (["sendMessage", "editMessageText", "sendDocument", "sendPhoto"].includes(method)) return ok({ message_id: calls.length })
    throw new Error(`Unexpected mock method: ${method}`)
  }
  return { http, calls }
}
const receive = (batches: unknown[][], broken = false) => Effect.scoped(Effect.gen(function* () {
  const deps = fixture()
  const mock = transport(batches, broken)
  const seen: string[] = []
  const channel = yield* makeTelegramChannel(options, { ...deps, http: mock.http })
  yield* channel.listen((text) => Effect.sync(() => { seen.push(text) })).pipe(Effect.exit)
  return { ...mock, ...deps, seen }
}))

test("authorized photos and image documents enter the shared image path with saved bytes and captions", () => Effect.runPromise(Effect.gen(function* () {
  const result = yield* receive([[update(1, { photo, caption: "Describe this photo" }), update(2, { document, caption: "Read this screenshot" })]])
  expect(result.seen).toHaveLength(2)

  for (const [i, caption] of ["Describe this photo", "Read this screenshot"].entries()) {
    const parsed = imagesIn(result.seen[i]!, result.project)
    expect(parsed.images).toHaveLength(1)
    expect(parsed.text).toContain(caption)
    expect(parsed.text).toContain("[Image #1]")
    expect(readFileSync(parsed.images[0]!.path)).toEqual(bytes)
    expect(parsed.images[0]!.path.startsWith(join(result.home, "telegram", "attachments"))).toBe(true)
  }

  expect(result.calls.filter((c) => c.method === "getFile").map((c) => c.body.file_id)).toEqual(["large", "document"])
})))

test("photo-only messages are accepted and command-like captions remain ordinary prompts", () => Effect.runPromise(Effect.gen(function* () {
  const result = yield* receive([[update(1, { photo }), update(2, { photo, caption: "!touch /tmp/not-a-command" }), update(3, { photo, caption: "/stop" })]])
  expect(result.seen).toHaveLength(3)
  expect(result.seen[1]).toContain("!touch /tmp/not-a-command")
  expect(result.seen[2]).toContain("/stop")

  for (const text of result.seen) {
    expect(text.trimStart()).not.toMatch(/^[!/]/)
    expect(imagesIn(text, result.project).images).toHaveLength(1)
  }
})))

test("unauthorized, group, and bot attachments are never fetched; unsupported captions are ignored", () => Effect.runPromise(Effect.gen(function* () {
  const result = yield* receive([[
    update(1, { photo, from: { id: 99, is_bot: false } }),
    update(2, { document, chat: { id: 42, type: "group" } }),
    update(3, { photo, from: { id: 42, is_bot: true } }),
    update(4, { document, chat: { id: 99, type: "private" } }),
    update(5, { voice: { file_id: "voice" }, caption: "do not dispatch" }),
    update(6, { video: { file_id: "video" }, caption: "nor this caption" }),
    update(7, { text: "still listening" }),
  ]])
  expect(result.seen).toEqual(["still listening"])
  expect(result.calls.filter((c) => ["getFile", "download"].includes(c.method))).toEqual([])
})))

test("duplicate attachment updates are not downloaded or dispatched twice", () => Effect.runPromise(Effect.gen(function* () {
  const attachment = update(1, { photo, caption: "once" })
  const result = yield* receive([[attachment, attachment], [attachment, update(2, { text: "next" })]])
  expect(result.seen).toHaveLength(2)
  expect(result.seen[1]).toBe("next")
  expect(result.calls.filter((c) => c.method === "getFile")).toHaveLength(1)
  expect(result.calls.filter((c) => c.method === "download")).toHaveLength(1)
})))

test("failed downloads report a sanitized error and do not lose the next text update", () => Effect.runPromise(Effect.gen(function* () {
  const result = yield* receive([[update(1, { photo }), update(2, { text: "next survives" })]], true)
  expect(result.seen).toEqual(["next survives"])
  expect(result.calls.filter((c) => c.method === "download")).toHaveLength(1)
  const reports = result.calls.filter((c) => c.method === "sendMessage").map((c) => c.body.text)
  expect(reports).toHaveLength(1)
  expect(reports[0]).toContain("Could not receive attachment")
  expect(reports[0]).not.toMatch(/secret|upstream|123:fake-test-only|https?:\/\//)
})))

test("sendFile uploads multipart bytes, serializes with text, throttles, and resets progress", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const deps = fixture()
  const path = join(deps.home, "report.txt")
  writeFileSync(path, "local report bytes")
  const mock = transport([])
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let uploading = false
  const http: Http = async (url, init) => {
    const response = await mock.http(url, init)
    if (url.endsWith("/sendDocument")) {
      uploading = true
      await gate
    }
    return response
  }
  const channel = yield* makeTelegramChannel(options, { ...deps, sendIntervalMs: 25, http })
  expect(channel.sendFile).toBeDefined()
  yield* channel.progress!("working")
  const file = yield* Effect.forkChild(channel.sendFile!(path, "Your report"))
  while (!uploading) yield* Effect.sleep(1)
  const text = yield* Effect.forkChild(channel.send("after upload"))
  yield* Effect.sleep(35)
  expect(mock.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1)
  const releasedAt = Date.now()
  release()
  yield* Fiber.join(file)
  yield* Fiber.join(text)
  yield* channel.progress!("working again")
  yield* channel.sendFile!(path)
  yield* channel.progress!("working again")

  const sent = mock.calls.filter((c) => ["sendMessage", "sendDocument", "editMessageText"].includes(c.method))
  expect(sent.map((c) => c.method)).toEqual(["sendMessage", "sendDocument", "sendMessage", "sendMessage", "sendDocument", "sendMessage"])
  expect(sent[2]!.at - releasedAt).toBeGreaterThanOrEqual(20)

  for (let i = 1; i < sent.length; i++) {
    expect(sent[i]!.at - sent[i - 1]!.at).toBeGreaterThanOrEqual(20)
  }

  const form = sent[1]!.body as FormData
  expect(form).toBeInstanceOf(FormData)
  expect(form.get("chat_id")).toBe("42")
  expect(form.get("caption")).toBe("Your report")
  expect(sent[1]!.init.headers).toBeUndefined()
  const upload = form.get("document") as File
  expect(upload.name).toMatch(/\.txt$/)
  const uploaded = yield* Effect.promise(() => upload.text())
  expect(uploaded).toBe("local report bytes")
}))))
