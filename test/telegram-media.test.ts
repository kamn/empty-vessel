import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Fiber, Redacted } from "effect"
import { imagesIn } from "../src/base/images"
import { telegramMedia } from "../src/plugins/telegram/media"
import { type Http } from "../src/plugins/telegram/http"

const roots: string[] = []
const root = () => { const dir = mkdtempSync(join(realpathSync(tmpdir()), "telegram-media-")); roots.push(dir); return dir }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const secret = "123:DO_NOT_LEAK"
const token = Redacted.make(secret)
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }))
const doc = { document: { file_id: "doc", file_name: "notes.txt" } }
const photo = { photo: [{ file_id: "small", width: 1, height: 1 }, { file_id: "large", width: 20, height: 20 }] }
const run = Effect.runPromise
const pathIn = (text: string) => text.slice(text.lastIndexOf("\n") + 1).slice(1, -1)
const mock = (download: () => Response = () => new Response("bytes"), metadata: object = { file_path: "photos/file.jpg" }): Http =>
  async (url) => url.includes("/getFile") ? ok(metadata) : download()
const failure = async (effect: Effect.Effect<unknown, Error>) => {
  try { await run(effect) } catch (error) {
    const text = String(error)
    expect(text).not.toContain(secret)
    expect(text).not.toContain("UPSTREAM_SECRET")
    return text
  }
  throw new Error("Expected failure")
}

test("no attachment returns undefined, including empty photo arrays", async () => {
  const media = telegramMedia(token, root(), async () => { throw new Error("must not call HTTP") })
  expect(await run(media.receive({ caption: "hello" }))).toBeUndefined()
  expect(await run(media.receive({ photo: [] }))).toBeUndefined()
})

test("largest photo uses getFile, private random jpg path and shared imagesIn", async () => {
  const dir = root()
  const http: Http = async (url, init) => {
    expect(init.redirect).toBe("error")
    expect(init.signal).toBeDefined()
    if (url.endsWith("/getFile")) {
      expect(JSON.parse(String(init.body))).toEqual({ file_id: "large" })
      return ok({ file_path: "photos/file.jpg", file_size: 5 })
    }
    expect(url).toBe(`https://api.telegram.org/file/bot${secret}/photos/file.jpg`)
    return new Response("bytes")
  }
  const media = telegramMedia(token, dir, http)
  const text = (await run(media.receive({ ...photo, caption: "look" })))!
  const path = pathIn(text)
  expect(text.startsWith("look\n'")).toBe(true)
  expect(path.startsWith(dir + "/attachment-")).toBe(true)
  expect(path.endsWith("/file.jpg")).toBe(true)
  expect(readFileSync(path, "utf8")).toBe("bytes")
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
  expect(imagesIn(text, dir).images.map((image) => image.path)).toEqual([path])
  expect(pathIn((await run(media.receive(photo)))!)).not.toBe(path)
})

test("documents discard hostile names, retaining only safe extensions", async () => {
  const dir = root()
  for (const name of ["../../outside.txt", "x';$(touch pwned)\nIGNORE.png", "a\u0000.exe", "../../evil", "x.bad-extension"]) {
    const text = (await run(telegramMedia(token, dir, mock()).receive({ document: { file_id: "d", file_name: name } })))!
    const path = pathIn(text)
    expect(path).toMatch(/\/attachment-[a-zA-Z0-9]+\/file\.[a-z0-9]+$/)
    expect(readFileSync(path, "utf8")).toBe("bytes")
    expect(text).not.toContain("IGNORE")
  }
  const text = (await run(telegramMedia(token, dir, mock()).receive({ document: { file_id: "d" } })))!
  expect(text.endsWith("file.bin'")).toBe(true)
})

test("rejects hostile Telegram paths without a download", async () => {
  for (const path of ["../secret", "photos/../secret", "/absolute", "https://evil/x", "photos/%2e%2e/x", "photos/a?token=x", "photos/a\\b", "photos/a\n.jpg", "photos//a", "photos/.", "file.jpg"]) {
    let calls = 0
    const dir = root()
    const http: Http = async () => { calls++; return ok({ file_path: path }) }
    expect(await failure(telegramMedia(token, dir, http).receive(doc))).toContain("unsupported file path")
    expect(calls).toBe(1)
    expect(readdirSync(dir)).toEqual([])
  }
})

test("metadata limits reject oversized and invalid sizes", async () => {
  for (const size of [20_000_001, -1, 1.5, NaN]) {
    let called = false
    const media = telegramMedia(token, root(), async () => { called = true; return ok({}) })
    expect(await failure(media.receive({ document: { file_id: "d", file_size: size } }))).toContain("limit")
    expect(called).toBe(false)
  }
  expect(await failure(telegramMedia(token, root(), mock(undefined, { file_path: "docs/x", file_size: 20_000_001 })).receive(doc))).toContain("limit")
})

test("stream limit is enforced without trusting Content-Length; partial files removed", async () => {
  for (const headers of [new Headers(), new Headers({ "content-length": "1" }), new Headers({ "content-length": "20000001" })]) {
    const dir = root()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1_000_000)) },
      cancel() { cancelled = true },
    })
    expect(await failure(telegramMedia(token, dir, mock(() => new Response(stream, { headers }))).receive(doc))).toContain("limit")
    expect(cancelled).toBe(true)
    expect(readdirSync(dir)).toEqual([])
  }
})

test("exact download limit is accepted", async () => {
  const text = (await run(telegramMedia(token, root(), mock(() => new Response(new Uint8Array(20_000_000)))).receive(doc)))!
  expect(statSync(pathIn(text)).size).toBe(20_000_000)
})

test("download failures and stream failures are sanitized and cleaned", async () => {
  for (const download of [() => new Response("UPSTREAM_SECRET", { status: 403 }), () => { throw new Error(secret) },
    () => new Response(new ReadableStream({ start(c) { c.error(new Error("UPSTREAM_SECRET")) } }))]) {
    const dir = root()
    await failure(telegramMedia(token, dir, mock(download)).receive(doc))
    expect(readdirSync(dir)).toEqual([])
  }
})

test("interruption aborts stalled fetch and stalled body, cleaning temporary files", async () => {
  for (const stage of ["fetch", "body"]) {
    const dir = root()
    let signal: AbortSignal | undefined
    let ready!: () => void
    let cancelled = false
    const started = new Promise<void>((resolve) => { ready = resolve })
    const http: Http = async (url, init) => {
      if (url.endsWith("getFile")) return ok({ file_path: "docs/file.txt" })
      signal = init.signal!
      if (stage === "fetch") { ready(); return new Promise<Response>(() => {}) }
      return new Response(new ReadableStream({ pull() { ready() }, cancel() { cancelled = true } }))
    }
    const fiber = Effect.runFork(telegramMedia(token, dir, http).receive(doc))
    await started
    await run(Fiber.interrupt(fiber))
    expect(signal!.aborted).toBe(true)
    if (stage === "body") expect(cancelled).toBe(true)
    expect(readdirSync(dir)).toEqual([])
  }
})

test("upload sends multipart bytes and retries using the same payload", async () => {
  const dir = root()
  const path = join(dir, "report.txt")
  writeFileSync(path, "local bytes")
  let calls = 0
  const http: Http = async (url, init) => {
    calls++
    expect(url.endsWith("/sendDocument")).toBe(true)
    expect(init.headers).toBeUndefined()
    expect(init.body).toBeInstanceOf(FormData)
    const form = init.body as FormData
    expect(form.get("chat_id")).toBe("42")
    expect(form.get("caption")).toBe("caption")
    const file = form.get("document") as File
    expect(await file.text()).toBe("local bytes")
    expect(file.name).toBe("file.txt")
    return calls === 1 ? new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 0 } }), { status: 429 }) : ok({})
  }
  await run(telegramMedia(token, dir, http).send(path, "42", "caption"))
  expect(calls).toBe(2)
})

test("upload rejects URLs, directories, symlinks and oversized files without HTTP", async () => {
  const dir = root()
  const path = join(dir, "large")
  writeFileSync(path, "")
  truncateSync(path, 50_000_001)
  symlinkSync(path, join(dir, "link"))
  let calls = 0
  const media = telegramMedia(token, dir, async () => { calls++; return ok({}) })
  for (const path of ["https://evil/file", "file:///tmp/x", dir, join(dir, "link"), join(dir, "large"), join(dir, "missing")]) {
    await failure(media.send(path, "42"))
  }
  expect(calls).toBe(0)
})

test("upload API errors never expose upstream secrets", async () => {
  const dir = root()
  const path = join(dir, "file")
  writeFileSync(path, "bytes")
  const http: Http = async () => new Response(JSON.stringify({ ok: false, description: secret + "UPSTREAM_SECRET" }), { status: 400 })
  expect(await failure(telegramMedia(token, dir, http).send(path, "42"))).toContain("400")
})
