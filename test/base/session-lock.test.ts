import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { processStart } from "../../src/base/files"
import { makeSession, openSession, SESSIONS } from "../../src/base/session"
import { diskStore } from "../../src/base/store"

const id = "01aaaaaa-0000-7000-8000-000000000002"
const key = `${SESSIONS}/${id}`
const homeOwnedBy = (owner: unknown) => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-"))
  mkdirSync(join(home, key), { recursive: true })
  writeFileSync(join(home, key, "main.jsonl"), '{"role":"project","text":"/p","ts":1}\n')
  if (owner !== undefined) writeFileSync(join(home, key, "owner.json"), JSON.stringify(owner))
  return home
}
const open = (home: string) => Effect.runPromise(Effect.result(openSession(key)).pipe(Effect.provide(diskStore(home))))
const owner = (home: string) => JSON.parse(readFileSync(join(home, key, "owner.json"), "utf8"))

// A live process that isn't this one: the second owner.
const other = Bun.spawn(["sleep", "30"])
afterAll(() => other.kill())

test("a second owner of a live session is refused, and the lease stays the holder's", async () => {
  const held = { pid: other.pid, startedAt: processStart(other.pid) }
  const home = homeOwnedBy(held)

  const result = await open(home)

  expect(result._tag).toBe("Failure")
  expect(String((result as { failure: { cause: unknown } }).failure.cause)).toContain(`pid ${other.pid}`)
  expect(owner(home)).toEqual(held)
  expect(readFileSync(join(home, key, "main.jsonl"), "utf8")).not.toContain("resumed")
})

test("a lease from a dead pid, from this pid, or with another start time is taken over", async () => {
  const dead = Bun.spawn(["true"])
  await dead.exited

  for (const stale of [{ pid: dead.pid, startedAt: "Thu Jan  1 00:00:00 2026" }, { pid: process.pid, startedAt: "anything" },
    { pid: other.pid, startedAt: "Thu Jan  1 00:00:00 2026" }, "not json"]) {
    const home = homeOwnedBy(stale)
    expect((await open(home))._tag).toBe("Success")
    expect(owner(home)).toEqual({ pid: process.pid, startedAt: processStart(process.pid) })
  }
})

test("a new root session records its owner; a sub-agent's session doesn't", async () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-"))
  const root = await Effect.runPromise(makeSession(SESSIONS).pipe(Effect.provide(diskStore(home))))
  const child = await Effect.runPromise(makeSession(root.key).pipe(Effect.provide(diskStore(home))))

  expect(JSON.parse(readFileSync(join(home, root.key, "owner.json"), "utf8")).pid).toBe(process.pid)
  expect(() => readFileSync(join(home, child.key, "owner.json"))).toThrow()
})
