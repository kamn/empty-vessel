import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { logEntries, makeSession, openSession, SESSIONS } from "../../src/base/session"
import { diskStore, Store } from "../../src/base/store"
import { loadConversation } from "../../src/loop/resume"
import { pastSessions } from "../../src/loop/past"

const id = "01aaaaaa-0000-7000-8000-000000000001"
const homeWith = (main: string) => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-"))
  mkdirSync(join(home, SESSIONS, id), { recursive: true })
  writeFileSync(join(home, SESSIONS, id, "main.jsonl"), main)
  return home
}
const run = <A, E>(home: string, effect: Effect.Effect<A, E, any>) => Effect.runPromise(effect.pipe(Effect.provide(diskStore(home))) as Effect.Effect<A, E>)
const lines = (home: string) => readFileSync(join(home, SESSIONS, id, "main.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))

test("a torn last line is cut on open: the next entry lands on its own line and every whole entry reads back", async () => {
  const home = homeWith('{"role":"project","text":"/p","ts":1}\n{"role":"user","text":"hi","ts":2}\n{"role":"assistant","text":"hel')

  await run(home, Effect.gen(function* () {
    const session = yield* openSession(`${SESSIONS}/${id}`)
    yield* session.record("user", "again")
  }))

  expect(lines(home).map((e) => e.role)).toEqual(["project", "user", "resumed", "user"])
  expect(loadConversation(join(home, SESSIONS, id)).history).toEqual([])
})

test("seq keeps increasing across reopen; an old log without seq continues from its line count", async () => {
  const home = homeWith('{"role":"project","text":"/p","ts":1}\n{"role":"user","text":"hi","ts":2}\n{"role":"assistant","text":"hello","ts":3}\n')

  await run(home, openSession(`${SESSIONS}/${id}`))
  await run(home, Effect.gen(function* () {
    const session = yield* openSession(`${SESSIONS}/${id}`)
    yield* session.record("user", "more")
  }))

  expect(lines(home).map((e) => e.seq)).toEqual([undefined, undefined, undefined, 3, 4, 5])

  const fresh = mkdtempSync(join(tmpdir(), "empty-vessel-home-"))
  const made = await run(fresh, makeSession(SESSIONS))
  expect(readFileSync(join(fresh, made.key, "main.jsonl"), "utf8")).toContain('"seq":0')
})

test("the shared reader skips torn lines, non-objects and entry types this version doesn't know", () => {
  const text = '{"role":"user","text":"a","ts":1}\n{"role":"fromTheFuture","text":"x","ts":2}\n42\nnull\n{"role":"assistant","text":"b","ts":3}\n{"role":"ass'
  expect(logEntries(text).map((e) => e.role)).toEqual(["user", "assistant"])
  expect(logEntries(undefined)).toEqual([])
})

test("unknown entry types are skipped by resume and session search", async () => {
  const project = mkdtempSync(join(tmpdir(), "empty-vessel-project-"))
  const home = homeWith([JSON.stringify({ role: "project", text: project, ts: 1 }), '{"role":"user","text":"find the needle","ts":2}',
    '{"role":"fromTheFuture","text":"needle","ts":3}', '{"role":"assistant","text":"needle found","ts":4}', ""].join("\n"))

  expect(loadConversation(join(home, SESSIONS, id)).history).toEqual([{ user: "find the needle", answer: "needle found" }])
  expect((await run(home, pastSessions("needle", { cwd: project }))).sessions[0]!.messages.map((m) => m.role).sort()).toEqual(["assistant", "user"])
})

test("after an append with an unknown outcome the session stops writing", async () => {
  const home = homeWith('{"role":"project","text":"/p","ts":1}\n')
  const disk = Effect.runSync(Effect.gen(function* () { return yield* Store }).pipe(Effect.provide(diskStore(home))))
  let failing = false
  const flaky = Layer.succeed(Store, { ...disk, append: (key, text, options) => (failing ? Effect.die("disk gone") : disk.append(key, text, options)) })

  const outcome = await Effect.runPromise(Effect.gen(function* () {
    const session = yield* openSession(`${SESSIONS}/${id}`)
    failing = true
    const first = yield* Effect.exit(session.record("user", "lost"))
    failing = false
    const second = yield* Effect.flip(session.record("user", "after"))
    return { first: first._tag, second: second._tag }
  }).pipe(Effect.provide(flaky)))

  expect(outcome).toEqual({ first: "Failure", second: "SessionError" })
  expect(lines(home).map((e) => e.text)).not.toContain("after")
})

test("an fsync append writes the same line as a plain one", async () => {
  const home = homeWith("")
  await run(home, Effect.gen(function* () {
    const store = yield* Store
    yield* store.append(`${SESSIONS}/${id}/main.jsonl`, '{"role":"user","text":"a","ts":1}\n', { sync: true })
    yield* store.append(`${SESSIONS}/${id}/main.jsonl`, '{"role":"user","text":"b","ts":2}\n')
  }))

  expect(lines(home).map((e) => e.text)).toEqual(["a", "b"])
})
