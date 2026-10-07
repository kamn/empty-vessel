import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { recordUsage, Usage } from "../../src/base/usage"
import { CurrentSession, makeSession, openSession, type SessionHandle } from "../../src/base/session"
import { diskStore } from "../../src/base/store"

const homes: string[] = []
const store = () => {
  const home = mkdtempSync(join(tmpdir(), "durable-usage-"))
  homes.push(home)
  return diskStore(home)
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })
const rows = (s: SessionHandle) => readFileSync(join(s.dir, "main.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
const request = { system: "systemOne" as const, model: "jev-latest", tokens: { input: 10, output: 2 }, provider: "jev" }

test("durable usage has versioned nested metadata, recorder time, and distinct request IDs", () => Effect.runPromise(Effect.gen(function* () {
  const session = yield* makeSession("sessions")
  const before = Date.now()
  const action = recordUsage(request)
  const a = yield* action.pipe(Effect.provideService(CurrentSession, session))
  const b = yield* action.pipe(Effect.provideService(CurrentSession, session))
  expect(a).toBeString()
  expect(b).not.toBe(a)
  const usage = rows(session).filter((r) => r.role === "usage")
  expect(usage).toHaveLength(2)
  expect(usage[0]).toEqual({ role: "usage", text: "model request", ts: expect.any(Number), extra: {
    usageVersion: 1, usageId: a, system: "systemOne", model: "jev-latest", agent: session.key, input: 10, output: 2, provider: "jev",
  } })
  expect(usage[0].ts).toBeGreaterThanOrEqual(before)
  expect(usage[0].ts).toBeLessThanOrEqual(Date.now())
}).pipe(Effect.provide(store()))))

test("CurrentSession selects concurrent root/child; resume appends without losing events", () => Effect.runPromise(Effect.gen(function* () {
  const root = yield* makeSession("sessions")
  const child = yield* makeSession(root.key)
  yield* Effect.all([root, child].map((session) => recordUsage({ ...request, system: "systemTwo", model: "test-model", tokens: { input: 10, output: 4, cached: 3, thinking: 2 } }).pipe(Effect.provideService(CurrentSession, session))), { concurrency: "unbounded" })
  const original = readFileSync(join(root.dir, "main.jsonl"), "utf8")
  const resumed = yield* openSession(root.key)
  yield* recordUsage(request).pipe(Effect.provideService(CurrentSession, resumed))
  expect(readFileSync(join(root.dir, "main.jsonl"), "utf8").startsWith(original)).toBe(true)
  const rootUsage = rows(root).filter((r) => r.role === "usage")
  const childUsage = rows(child).filter((r) => r.role === "usage")
  expect(rootUsage).toHaveLength(2)
  expect(childUsage).toHaveLength(1)
  expect(rootUsage.every((r) => r.extra.agent === root.key)).toBe(true)
  expect(childUsage[0].extra).toMatchObject({ agent: child.key, system: "systemTwo", cached: 3, thinking: 2 })
}).pipe(Effect.provide(store()))))

test("no CurrentSession means no event and no ID; aggregates do not persist usage", () => Effect.runPromise(Effect.gen(function* () {
  expect(yield* recordUsage(request)).toBeUndefined()
  const session = yield* makeSession("sessions")
  const usage = yield* Usage
  yield* usage.add("systemOne", 1, request.tokens).pipe(Effect.provideService(CurrentSession, session))
  expect(rows(session).map((r) => r.role)).toEqual(["project"])
}).pipe(Effect.provide(store()), Effect.provide(Usage.layer))))

test("writer failure or synchronous throw preserves usage ID and successful result", () => Effect.runPromise(Effect.gen(function* () {
  for (const record of [() => Effect.die("disk unavailable"), () => { throw new Error("writer threw") }]) {
    const session = { id: "test", key: "sessions/test", dir: "/unused", record } as SessionHandle
    const id = yield* recordUsage({ ...request, usageId: "stable-request" }).pipe(Effect.provideService(CurrentSession, session))
    expect(id).toBe("stable-request")
  }
})))
