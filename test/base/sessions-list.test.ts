import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { listSessions, sessionLines, SESSIONS } from "../../src/base/session"
import { diskStore } from "../../src/base/store"

const session = (home: string, id: string, folder: string, users: ReadonlyArray<string>) => {
  mkdirSync(join(home, SESSIONS, id), { recursive: true })
  const entries = [{ role: "project", text: folder, ts: Date.UTC(2026, 9, 20, 12) }, ...users.flatMap((text) => [{ role: "user", text, ts: 2 }, { role: "assistant", text: "ok", ts: 3 }])]
  writeFileSync(join(home, SESSIONS, id, "main.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n")
}

test("listSessions: this folder's sessions newest first, with message counts and the first message; --all every folder's", async () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-"))
  session(home, "01-a", "/p", ["fix the login bug", "and the tests"])
  session(home, "02-b", "/other", ["unrelated"])
  session(home, "03-c", "/p", [])
  const list = (cwd: string | undefined, limit?: number) => Effect.runPromise(listSessions(cwd, limit).pipe(Effect.provide(diskStore(home))))

  const here = await list("/p")
  expect(here.map((s) => [s.id, s.messages, s.first])).toEqual([["03-c", 0, undefined], ["01-a", 2, "fix the login bug"]])
  expect((await list(undefined)).map((s) => s.id)).toEqual(["03-c", "02-b", "01-a"])
  expect((await list(undefined, 1)).map((s) => s.id)).toEqual(["03-c"])

  const [line] = sessionLines([here[1]!], true)
  expect(line).toStartWith("01-a  2026-10-20 ")
  expect(line).toEndWith('  2 messages  /p "fix the login bug"')
})
