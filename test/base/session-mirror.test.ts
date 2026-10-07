import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Effect, Schema } from "effect"
import { Config, ConfigSchema } from "../../src/base/config"
import { Events } from "../../src/base/events"
import { Usage } from "../../src/base/usage"
import { turn } from "../../src/loop/turn"
import { newConversation, type Needs } from "../../src/loop/turnkit"
import { FakeSystemOne } from "../../src/system-one/systemone"
import { FakeSystemTwo, SystemTwo } from "../../src/system-two/systemtwo"
import { CurrentSession, SessionMirror, makeSession, openSession, type SessionEntry, type SessionHandle } from "../../src/base/session"
import { diskStore } from "../../src/base/store"

const homes: string[] = []
const temporaryStore = () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-session-mirror-"))
  homes.push(home)
  return diskStore(home)
}
const entries = (session: SessionHandle): Array<Record<string, unknown>> =>
  readFileSync(join(session.dir, "main.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
const collect = (seen: SessionEntry[]) => (entry: SessionEntry) => Effect.sync(() => { seen.push(entry) })

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

test("default references need no provider: recording still appends to the Store", () => Effect.runPromise(Effect.gen(function* () {
  expect(yield* CurrentSession).toBeUndefined()
  const session = yield* makeSession("sessions")
  yield* session.record("user", "without an exporter", { source: "test" })
  yield* (yield* SessionMirror)({ key: session.key, role: "assistant", text: "noop", ts: 1, extra: {} })

  const saved = entries(session)
  expect(saved.map((entry) => entry.role)).toEqual(["project", "user"])
  expect(saved[1]).toMatchObject({ text: "without an exporter", source: "test", ts: expect.any(Number) })
  expect(yield* CurrentSession).toBeUndefined()
}).pipe(Effect.provide(temporaryStore()))))

test("mirror receives the stable key, exact timestamp and extra only after the Store append", () => {
  const store = temporaryStore(), seen: SessionEntry[] = [], before = Date.now(), home = homes.at(-1)!
  return Effect.runPromise(Effect.gen(function* () {
    const session = yield* makeSession("sessions")
    const extra = { child: "child-id", confidence: 0.75, nested: { values: [1, "two"] } }
    yield* session.record("spawn", "child task", extra)
    yield* session.record("assistant", "finished")

    expect(seen.map((entry) => entry.role)).toEqual(["project", "spawn", "assistant"])
    expect(seen.every((entry) => entry.key === session.key)).toBe(true)
    expect(session.key).toBe(`sessions/${session.id}`)
    expect(seen[1]!.extra).toEqual(extra)
    expect(seen[2]!.extra).toEqual({})
    expect(seen.every((entry) => Number.isInteger(entry.ts) && entry.ts >= before && entry.ts <= Date.now())).toBe(true)
  }).pipe(Effect.provideService(SessionMirror, (entry) => Effect.sync(() => {
    // Reading inside the callback proves append ordering, not just eventual persistence.
    const saved = readFileSync(join(home, entry.key, "main.jsonl"), "utf8")
    expect(JSON.parse(saved!.trim().split("\n").at(-1)!)).toEqual({ role: entry.role, text: entry.text, ...entry.extra, ts: entry.ts })
    seen.push(entry)
  })), Effect.provide(store)))
})

test("openSession resumes the same key and record uses the calling scope's mirror", () => Effect.runPromise(Effect.gen(function* () {
  const first: SessionEntry[] = [], resumedEntries: SessionEntry[] = []
  const original = yield* makeSession("sessions").pipe(Effect.provideService(SessionMirror, collect(first)))
  const originalLine = entries(original)[0]
  const resumed = yield* openSession(original.key).pipe(Effect.provideService(SessionMirror, collect(resumedEntries)))
  yield* original.record("user", "old handle, new scope").pipe(Effect.provideService(SessionMirror, collect(resumedEntries)))
  yield* resumed.record("assistant", "resumed answer").pipe(Effect.provideService(SessionMirror, collect(resumedEntries)))
  yield* resumed.record("user", "outside mirror scope")

  expect(resumed.key).toBe(original.key)
  expect(resumed.id).toBe(original.id)
  expect(resumed.dir).toBe(original.dir)
  expect(first.map((entry) => entry.role)).toEqual(["project"])
  expect(resumedEntries.map((entry) => entry.role)).toEqual(["resumed", "user", "assistant"])
  expect(resumedEntries.every((entry) => entry.key === original.key)).toBe(true)
  expect(entries(resumed)[0]).toEqual(originalLine)
  expect(entries(resumed).map((entry) => entry.role)).toEqual(["project", "resumed", "user", "assistant", "user"])
}).pipe(Effect.provide(temporaryStore()))))

test("parallel sessions isolate CurrentSession and SessionMirror across suspended fibers", () => Effect.runPromise(Effect.gen(function* () {
  const sessions = yield* Effect.all([makeSession("sessions"), makeSession("sessions")])
  const ready = yield* Effect.all([Deferred.make<void>(), Deferred.make<void>()])
  const seen: SessionEntry[][] = [[], []]
  const work = (session: SessionHandle, i: number) => Effect.gen(function* () {
    expect(yield* CurrentSession).toBe(session)
    yield* session.record("user", `start ${i}`)
    yield* Deferred.succeed(ready[i]!, undefined)
    yield* Deferred.await(ready[1 - i]!) // Both scopes are alive before either continues.
    expect(yield* CurrentSession).toBe(session)
    yield* session.record("assistant", `end ${i}`)
  }).pipe(Effect.provideService(CurrentSession, session), Effect.provideService(SessionMirror, collect(seen[i]!)))

  yield* Effect.all(sessions.map(work), { concurrency: "unbounded" })

  for (const [i, session] of sessions.entries()) {
    expect(seen[i]!.map((entry) => entry.key)).toEqual([session.key, session.key])
    expect(seen[i]!.map((entry) => entry.text)).toEqual([`start ${i}`, `end ${i}`])
    expect(entries(session).slice(1).map((entry) => entry.text)).toEqual([`start ${i}`, `end ${i}`])
  }

  expect(yield* CurrentSession).toBeUndefined()
  yield* sessions[0]!.record("user", "outside both scopes")
  expect(seen.map((list) => list.length)).toEqual([2, 2])
}).pipe(Effect.provide(temporaryStore()))))

test("turn scopes auxiliary compaction, resets a mirrorless child's turn, and restores its parent", async () => {
  const store = temporaryStore(), cwd = process.cwd(), home = homes.at(-1)!
  const seen: SessionEntry[] = [], inherited: SessionEntry[] = []
  const config = Schema.decodeUnknownSync(ConfigSchema)({ testOptions: true, compactAt: 10, learnAfterTurn: false })
  // No project library or adoption files from the real checkout are used.
  process.chdir(home)

  try {
    await Effect.runPromise(Effect.gen(function* () {
      const fake = yield* SystemTwo
      const services = (yield* Effect.context<Needs>()).pipe(Context.omit(SessionMirror, CurrentSession))
      const parent = yield* makeSession("sessions")
      const child = yield* makeSession(parent.key)
      const conversation = newConversation(), childConversation = newConversation()
      conversation.briefing = childConversation.briefing = "test briefing"
      conversation.size = 20
      let compactCalls = 0
      const provider: SystemTwo["Service"] = {
        ...fake,
        sessionMirror: collect(seen),
        compact: (thread, options) => Effect.gen(function* () {
          compactCalls++
          expect(yield* CurrentSession).toBe(parent)
          yield* (yield* CurrentSession)!.record("memory", "auxiliary call", { auxiliary: true })
          // The child enters the real turn wrapper under the parent's active mirror.
          // FakeSystemTwo has no exporter, like any non-Codex provider without a hook.
          const childReply = yield* turn(child, "child hello", 1, childConversation).pipe(Effect.provideService(SystemTwo, fake))
          expect(childReply).toContain("child hello")
          expect(yield* CurrentSession).toBe(parent)
          yield* parent.record("memory", "parent restored")
          yield* options.score(["old output"])
          return yield* fake.compact(thread, options)
        }).pipe(Effect.provideContext(services), Effect.orDie),
      }
      const reply = yield* turn(parent, "parent hello", 0, conversation).pipe(Effect.provideService(SystemTwo, provider))

      expect(reply).toContain("parent hello")
      expect(compactCalls).toBe(1)
      expect(seen.every((entry) => entry.key === parent.key)).toBe(true)
      expect(seen.filter((entry) => entry.role === "memory").map((entry) => entry.text)).toEqual(["auxiliary call", "parent restored"])
      expect(seen.find((entry) => entry.text === "auxiliary call")!.extra).toEqual({ auxiliary: true })
      expect(seen.some((entry) => entry.role === "compact")).toBe(true)
      expect(seen.some((entry) => entry.role === "decision")).toBe(true)
      expect(seen.some((entry) => entry.role === "assistant")).toBe(true)
      expect(entries(child).map((entry) => entry.role)).toContain("assistant")
      expect(entries(child).find((entry) => entry.role === "user")!.text).toBe("child hello")
      expect(yield* CurrentSession).toBeUndefined()
      yield* parent.record("user", "after parent turn")
      expect(inherited.map((entry) => entry.role)).toEqual(["project", "project", "user"])
      expect(inherited.at(-1)!.text).toBe("after parent turn")
      expect(seen.some((entry) => entry.text === "after parent turn")).toBe(false)
    }).pipe(
      Effect.provideService(SessionMirror, collect(inherited)),
      Effect.provideService(Config, config),
      Effect.provideService(Events, { emit: () => Effect.void }),
      Effect.provide(FakeSystemOne), Effect.provide(FakeSystemTwo),
      Effect.provide(Usage.layer), Effect.provide(store),
      // Echo and prefilled briefing avoid the remaining services; missing access fails loudly.
      Effect.provideContext(Context.empty() as Context.Context<Needs>),
    ))
  } finally {
    process.chdir(cwd)
  }
})
