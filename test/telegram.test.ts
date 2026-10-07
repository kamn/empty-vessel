import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Exit, Fiber, Redacted, Schema } from "effect"
import { Channel } from "empty-vessel"
import { makeTelegramChannel, telegram, telegramLayer } from "../src/plugins/telegram"
import { settings } from "../src/plugins/telegram/config"
import { splitText, telegramApi, type Http } from "../src/plugins/telegram/http"
import { hash, openState } from "../src/plugins/telegram/state"
import { tokenWorks } from "../src/plugins/telegram/setup"

const roots: string[] = []
const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-telegram-"))
  roots.push(home)
  return { home, project: home, sendIntervalMs: 0 }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const options = { token: Redacted.make("123:fake-test-only"), allowedUserId: "42", allowedChatId: "42" }
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }))
const fail = (status: number, retryAfter?: number) => new Response(JSON.stringify({
  ok: false, error_code: status, description: "SECRET URL/token must not escape", parameters: { retry_after: retryAfter },
}), { status })
const message = (update_id: number, text = "hello") => ({ update_id, message: {
  text, from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" },
} })
const fake = (poll: (body: any, init: RequestInit) => Response | Promise<Response>, send?: (body: any) => Response): Http =>
  (url, init) => {
    const method = url.split("/").at(-1)
    const body = JSON.parse(String(init.body))
    if (method === "getMe") return Promise.resolve(ok({ id: 123, is_bot: true }))
    if (method === "getWebhookInfo") return Promise.resolve(ok({ url: "" }))
    if (method === "sendMessage") return Promise.resolve(send?.(body) ?? ok({ message_id: 1 }))
    if (method === "getUpdates") return Promise.resolve(poll(body, init))
    throw new Error("Unexpected method")
  }
const aborting = (init: RequestInit, aborted: () => void) => new Promise<Response>((_, reject) => {
  init.signal!.addEventListener("abort", () => { aborted(); reject(new Error("aborted secret")) }, { once: true })
})

// A deliberate 401 terminates a finite scripted poll without timer-based assertions.
const runBatch = (batches: unknown[][], deps: ReturnType<typeof fixture>, seen: string[]) => Effect.scoped(Effect.gen(function* () {
  const channel = yield* makeTelegramChannel(options, { ...deps, http: fake(() => batches.length ? ok(batches.shift()) : fail(401)) })
  yield* channel.listen((text) => Effect.sync(() => { seen.push(text) })).pipe(Effect.exit)
}))

test("exports channel plugin and validates positive string IDs and redacted token", () => {
  expect(telegram.name).toBe("telegram")
  expect(telegram.provides.channel).toBeDefined()
  const decode = Schema.decodeUnknownSync(settings)
  const config = decode({ token: "123:fake-test-only", allowedUserId: "42", allowedChatId: "42" })
  expect(Redacted.isRedacted(config.token)).toBe(true)
  for (const id of ["-42", "0", "1.5", " 42", 42, "01"]) {
    expect(() => decode({ token: "secret", allowedUserId: id, allowedChatId: "42" })).toThrow()
  }
})

test("configuration rejects malformed secrets and unsafe IDs without exposing the token", () => {
  const decode = Schema.decodeUnknownSync(settings)
  const valid = { token: "123:fake-test-only", allowedUserId: "42", allowedChatId: "42" }

  for (const token of ["", "   ", "secret-no-colon", "123:secret with space"]) {
    expect(() => decode({ ...valid, token })).toThrow()
    try { decode({ ...valid, token }) } catch (error) {
      if (token.trim()) expect(String(error)).not.toContain(token)
    }
  }

  expect(() => decode({ ...valid, allowedUserId: "9007199254740992" })).toThrow()
  expect(() => decode({ ...valid, allowedChatId: "9007199254740992" })).toThrow()
  for (const stateDirectory of ["", "   "]) expect(() => decode({ ...valid, stateDirectory })).toThrow()
})

test("auth filters sender, chat, group, bots, edits and non-text; ignores duplicate IDs", () => Effect.runPromise(Effect.gen(function* () {
  const deps = fixture()
  const seen: string[] = []
  const wrongSender = message(2); wrongSender.message.from.id = 99
  const wrongChat = message(3); wrongChat.message.chat.id = 99
  const group = message(4); group.message.chat.type = "group"
  const bot = message(5); bot.message.from.is_bot = true
  yield* runBatch([[message(1), message(1), wrongSender, wrongChat, group, bot,
    { update_id: 6, edited_message: message(6).message },
    { update_id: 7, message: { ...message(7).message, text: undefined } }, message(8, "next")]], deps, seen)
  expect(seen).toEqual(["hello", "next"])
})))

test("offset is on disk before dispatch; session survives restart and duplicates never replay", () => Effect.runPromise(Effect.gen(function* () {
  const deps = fixture()
  const seen: string[] = []
  let polled = false
  const channelRun = Effect.scoped(Effect.gen(function* () {
    const channel = yield* makeTelegramChannel(options, { ...deps, http: fake(() => {
      if (polled) return fail(401)
      polled = true
      return ok([message(10)])
    }) })
    yield* channel.saveSession("session-1")
    yield* channel.listen((text) => Effect.sync(() => {
      const dir = join(deps.home, "telegram", "state")
      const path = join(dir, readdirSync(dir)[0]!)
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ offset: 11, session: "session-1" })
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      seen.push(text)
    })).pipe(Effect.exit)
  }))
  yield* channelRun
  yield* Effect.scoped(Effect.gen(function* () {
    let first = true
    const channel = yield* makeTelegramChannel(options, { ...deps, http: fake((body) => {
      expect(body.offset).toBeGreaterThanOrEqual(11)
      if (!first) return fail(401)
      first = false
      return ok([message(10), message(11, "new")])
    }) })
    expect(yield* channel.loadSession).toBe("session-1")
    yield* channel.listen((text) => Effect.sync(() => { seen.push(text) })).pipe(Effect.exit)
  }))
  expect(seen).toEqual(["hello", "new"])
})))

test("bot lock excludes other projects, chats and state directories; scope releases it", () => Effect.runPromise(Effect.gen(function* () {
  const deps = fixture()
  const http = fake(() => fail(401))
  const other = join(deps.home, "other")
  mkdirSync(other)
  yield* Effect.scoped(Effect.gen(function* () {
    yield* makeTelegramChannel(options, { ...deps, http })
    const collision = yield* Effect.scoped(makeTelegramChannel({ ...options, allowedChatId: "99", stateDirectory: other }, {
      ...deps, project: other, http,
    })).pipe(Effect.exit)
    expect(Exit.isFailure(collision)).toBe(true)
  }))
  yield* Effect.scoped(makeTelegramChannel(options, { ...deps, http }))
  expect(readdirSync(join(deps.home, "telegram", "locks"))).toEqual([])
})))

test("webhook rejected without deletion; failed startup releases lock", () => Effect.runPromise(Effect.gen(function* () {
  const deps = fixture()
  const calls: string[] = []
  const http: Http = (url) => {
    const method = url.split("/").at(-1)!
    calls.push(method)
    return Promise.resolve(ok(method === "getMe" ? { id: 123, is_bot: true } : { url: "https://secret.example/hook" }))
  }
  const exit = yield* Effect.scoped(makeTelegramChannel(options, { ...deps, http })).pipe(Effect.exit)
  expect(Exit.isFailure(exit)).toBe(true)
  expect(calls).toEqual(["getMe", "getWebhookInfo"])
  expect(readdirSync(join(deps.home, "telegram", "locks"))).toEqual([])
})))

test("chunks preserve emoji at UTF16 boundaries and sending uses plain authorized chat", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const text = "a".repeat(4095) + "😀" + "b".repeat(4094) + "🦊"
  const chunks = splitText(text)
  expect(chunks.join("")).toBe(text)
  expect(chunks.every((chunk) => chunk.length <= 4096 && chunk.isWellFormed())).toBe(true)
  expect(splitText("")).toEqual([])
  const sent: any[] = []
  const channel = yield* makeTelegramChannel(options, { ...fixture(), http: fake(() => fail(401), (body) => {
    sent.push(body); return ok({})
  }) })
  yield* channel.send(text)
  expect(sent).toEqual(chunks.map((text) => ({ chat_id: "42", text })))
}))))

test("429 retries are bounded and honor retry_after", () => Effect.runPromise(Effect.gen(function* () {
  let calls = 0
  const started = Date.now()
  const api = telegramApi(options.token, () => Promise.resolve(++calls === 1 ? fail(429, 0.02) : ok("done")))
  expect(yield* api.call("sendMessage")).toBe("done")
  expect(Date.now() - started).toBeGreaterThanOrEqual(15)
  expect(calls).toBe(2)
  calls = 0
  const exhausted = yield* telegramApi(options.token, () => { calls++; return Promise.resolve(fail(429, 0)) }).call("sendMessage").pipe(Effect.exit)
  expect(Exit.isFailure(exhausted)).toBe(true)
  expect(calls).toBe(4)
})))

test("long retry delay fails safely, permanent errors do not retry, and setup validates getMe", () => Effect.runPromise(Effect.gen(function* () {
  let calls = 0
  const http: Http = () => { calls++; return Promise.resolve(fail(401)) }
  expect(yield* tokenWorks("fake", http)).toBe(false)
  expect(calls).toBe(1)
  expect(yield* tokenWorks("fake", () => Promise.resolve(ok({ id: 123, is_bot: true })))).toBe(true)
  const result = yield* telegramApi(options.token, () => Promise.resolve(fail(429, 999))).call("sendMessage").pipe(Effect.flip)
  expect(result.message).toBe("Telegram request failed (429)")
  expect(JSON.stringify(result)).not.toContain("SECRET")
})))

test("interrupting poll aborts HTTP and releases the bot lock", () => Effect.runPromise(Effect.gen(function* () {
  const deps = fixture()
  let aborted = false
  let started = false
  const program = Effect.scoped(Effect.gen(function* () {
    const channel = yield* makeTelegramChannel(options, { ...deps, http: fake((_, init) => {
      started = true
      return aborting(init, () => { aborted = true })
    }) })
    yield* channel.listen(() => Effect.void)
  }))
  const fiber = yield* Effect.forkChild(program)
  while (!started) yield* Effect.sleep(1)
  yield* Fiber.interrupt(fiber)
  expect(aborted).toBe(true)
  expect(readdirSync(join(deps.home, "telegram", "locks"))).toEqual([])
})))

test("state keys canonicalize symlinks and isolate projects, tokens and chats", () => Effect.runPromise(Effect.gen(function* () {
  const deps = fixture()
  const dir = join(deps.home, "state")
  const alias = join(deps.home, "alias")
  symlinkSync(deps.home, alias)
  const first = yield* openState(dir, hash("token-a"), "42", deps.home)
  yield* first.save({ offset: 9, session: "a" })
  expect((yield* openState(dir, hash("token-a"), "42", alias)).get().session).toBe("a")
  expect((yield* openState(dir, hash("token-b"), "42", deps.home)).get().session).toBeUndefined()
  expect((yield* openState(dir, hash("token-a"), "99", deps.home)).get().session).toBeUndefined()
  const project = join(deps.home, "project")
  mkdirSync(project)
  expect((yield* openState(dir, hash("token-a"), "42", project)).get().session).toBeUndefined()
  writeFileSync(join(dir, readdirSync(dir)[0]!), "broken")
  expect(Exit.isFailure(yield* openState(dir, hash("token-a"), "42", deps.home).pipe(Effect.exit))).toBe(true)
})))

test("layer provides the public Channel contract and scopes resources", () => Effect.runPromise(Effect.gen(function* () {
  const deps = fixture()
  const program = Effect.gen(function* () {
    const channel = yield* Channel
    yield* channel.saveSession("layer-session")
    expect(yield* channel.loadSession).toBe("layer-session")
  }).pipe(Effect.provide(telegramLayer(options, { ...deps, http: fake(() => fail(401)) })))
  yield* program
  expect(readdirSync(join(deps.home, "telegram", "locks"))).toEqual([])
})))

test("HTTP errors never retain upstream URL, description, or token", () => Effect.runPromise(Effect.gen(function* () {
  const token = "private-bot-token"
  const api = telegramApi(Redacted.make(token), () => Promise.resolve(new Response(`invalid ${token}`, { status: 401 })))
  const rejected = yield* telegramApi(Redacted.make(token), () => Promise.resolve(fail(401))).call("sendMessage").pipe(Effect.flip)
  expect(String(rejected)).not.toContain(token)
  expect(String(rejected)).not.toContain("SECRET")
  const malformed = yield* api.call("sendMessage").pipe(Effect.flip)
  expect(String(malformed)).toBe("Error: Telegram request failed (401)")
})))

test("outbound retry sleep is cancellable without another attempt", () => Effect.runPromise(Effect.gen(function* () {
  let attempts = 0
  const api = telegramApi(options.token, () => { attempts++; return Promise.resolve(fail(429, 30)) })
  const fiber = yield* Effect.forkChild(api.call("sendMessage"))
  while (attempts === 0) yield* Effect.sleep(1)
  yield* Effect.sleep(5)
  yield* Fiber.interrupt(fiber)
  expect(attempts).toBe(1)
})))

test("pending sends do not block polling, and cancelling send aborts its request", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const deps = fixture()
  let sendStarted = false
  let sendAborted = false
  let first = true
  const base = fake(() => {
    if (!first) return fail(401)
    first = false
    return ok([message(1), message(2, "second")])
  })
  const http: Http = (url, init) => {
    if (url.endsWith("/sendMessage")) {
      sendStarted = true
      return aborting(init, () => { sendAborted = true })
    }
    return base(url, init)
  }
  const channel = yield* makeTelegramChannel(options, { ...deps, http })
  const send = yield* Effect.forkChild(channel.send("pending"))
  while (!sendStarted) yield* Effect.sleep(1)
  const seen: string[] = []
  yield* channel.listen((text) => Effect.sync(() => { seen.push(text) })).pipe(Effect.exit)
  expect(seen).toEqual(["hello", "second"])
  yield* Fiber.interrupt(send)
  expect(sendAborted).toBe(true)
}))))

test("concurrent sends are ordered and throttled across chunks", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const times: number[] = []
  const sent: string[] = []
  const channel = yield* makeTelegramChannel(options, { ...fixture(), sendIntervalMs: 20, http: fake(() => fail(401), (body) => {
    times.push(Date.now()); sent.push(body.text); return ok({})
  }) })
  yield* Effect.all([channel.send("a".repeat(4097)), channel.send("last")], { concurrency: 2 })
  expect(sent.map((text) => text.length)).toEqual([4096, 1, 4])
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(15)
  expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(15)
}))))

test("progress appends to one message and starts fresh after permanent replies", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const calls: Array<{ method: string; text: string; message_id?: number }> = []
  const base = fake(() => fail(401))
  const http: Http = (url, init) => {
    const method = url.split("/").at(-1)!
    if (method !== "sendMessage" && method !== "editMessageText") return base(url, init)
    calls.push({ method, ...JSON.parse(String(init.body)) })
    return Promise.resolve(ok({ message_id: calls.length }))
  }
  const channel = yield* makeTelegramChannel(options, { ...fixture(), http })
  yield* channel.progress!("Reading files")
  yield* channel.progress!("Running tests")
  yield* channel.progress!("Running tests")

  for (const reply of ["A note", "A question?", "Final reply"]) {
    yield* channel.send(reply)
    yield* channel.progress!("Next cell")
    yield* channel.progress!("Next update")
  }

  expect(calls.map(({ method }) => method)).toEqual([
    "sendMessage", "editMessageText",
    "sendMessage", "sendMessage", "editMessageText",
    "sendMessage", "sendMessage", "editMessageText",
    "sendMessage", "sendMessage", "editMessageText",
  ])
  expect(calls.filter(({ method }) => method === "editMessageText").map(({ message_id }) => message_id)).toEqual([1, 4, 7, 10])
  expect(calls.filter(({ method }) => method === "editMessageText").map(({ text }) => text)).toEqual([
    "Reading files\nRunning tests", "Next cell\nNext update", "Next cell\nNext update", "Next cell\nNext update",
  ])
}))))

test("progress preserves full messages and continues without truncating updates", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const calls: Array<{ method: string; text: string }> = []
  const base = fake(() => fail(401))
  const http: Http = (url, init) => {
    const method = url.split("/").at(-1)!
    if (method !== "sendMessage" && method !== "editMessageText") return base(url, init)
    calls.push({ method, ...JSON.parse(String(init.body)) })
    return Promise.resolve(ok({ message_id: calls.length }))
  }
  const channel = yield* makeTelegramChannel(options, { ...fixture(), http })
  yield* channel.progress!("")
  yield* channel.progress!("a".repeat(4094))
  yield* channel.progress!("b")
  yield* channel.progress!("c".repeat(4096) + "😀")
  yield* channel.progress!("done")
  yield* channel.progress!("done")
  yield* channel.send("reply")
  yield* channel.progress!("done")

  expect(calls.map(({ method }) => method)).toEqual([
    "sendMessage", "editMessageText", "sendMessage", "sendMessage", "editMessageText", "sendMessage", "sendMessage",
  ])
  expect(calls.map(({ text }) => text)).toEqual([
    "a".repeat(4094), "a".repeat(4094) + "\nb", "c".repeat(4096), "😀", "😀\ndone", "reply", "done",
  ])
}))))
