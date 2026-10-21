import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { projectDir } from "../../src/base/project"
import { diskStore } from "../../src/base/store"
import { pastSessions } from "../../src/loop/past"

// A session file in the Store: its project line, then messages.
const session = (home: string, id: string, project: string, lines: ReadonlyArray<readonly [string, string, number]>) => {
  mkdirSync(join(home, "sessions", id), { recursive: true })
  const entries = [{ role: "project", text: project, checks: projectDir(project), ts: 0 }, ...lines.map(([role, text, ts]) => ({ role, text, ts }))]
  writeFileSync(join(home, "sessions", id, "main.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n")
}

test("pastSessions: this project's messages with every word, newest first, with session and time; other projects and the current session left out", async () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-"))
  const here = mkdtempSync(join(tmpdir(), "empty-vessel-proj-")), elsewhere = mkdtempSync(join(tmpdir(), "empty-vessel-other-"))
  session(home, "01-old", here, [["user", "Should the cache use Redis?", 1000], ["assistant", "We decided: no Redis, an LRU cache in memory.", 2000], ["thread", "Redis cache internals", 2500]])
  session(home, "02-other", elsewhere, [["assistant", "Redis cache for the other project", 3000]])
  session(home, "03-new", here, [["assistant", "Redis cache is back on the table", 4000]])
  session(home, "04-current", here, [["user", "what did we decide about the redis cache?", 5000]])

  const found = await Effect.runPromise(pastSessions("redis CACHE", { cwd: here, exclude: "04-current" }).pipe(Effect.provide(diskStore(home))))

  expect(found.map((f) => [f.session, f.role])).toEqual([["03-new", "assistant"], ["01-old", "assistant"], ["01-old", "user"]])
  expect(found[1]!.at).toBe(new Date(2000).toISOString())
  expect(found[1]!.text).toContain("LRU cache")
  expect(await Effect.runPromise(pastSessions("redis", { cwd: here, limit: 1 }).pipe(Effect.provide(diskStore(home))))).toHaveLength(1)
  expect(await Effect.runPromise(pastSessions("  ", { cwd: here }).pipe(Effect.provide(diskStore(home))))).toEqual([])
})
