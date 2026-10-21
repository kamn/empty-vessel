import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { forkSession, SESSIONS } from "../../src/base/session"
import { diskStore } from "../../src/base/store"
import { loadConversation } from "../../src/loop/resume"

test("forkSession: a copy under a new id that resumes like the original; the original is unchanged and usage isn't copied", async () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-"))
  const id = "01aaaaaa-0000-7000-8000-000000000001", dir = join(home, SESSIONS, id)
  mkdirSync(join(dir, "kernel"), { recursive: true })
  const main = [
    { role: "project", text: "/p", ts: 1 },
    { role: "user", text: "first idea", ts: 2 },
    { role: "usage", text: "model request", extra: { agent: `${SESSIONS}/${id}` }, ts: 3 },
    { role: "assistant", text: "done it", ts: 4 },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n"
  writeFileSync(join(dir, "main.jsonl"), main)
  writeFileSync(join(dir, "kernel", "scope-1.ts"), `export * from "${dir}/kernel/cell-1.ts"\n`)

  const copy = await Effect.runPromise(forkSession(`${SESSIONS}/${id}`).pipe(Effect.provide(diskStore(home))))
  const copyDir = join(home, copy), copyId = copy.split("/").at(-1)!

  expect(copyId).not.toBe(id)
  expect(readFileSync(join(dir, "main.jsonl"), "utf8")).toBe(main)
  expect(loadConversation(copyDir).history).toEqual(loadConversation(dir).history)
  expect(readFileSync(join(copyDir, "main.jsonl"), "utf8")).not.toContain('"role":"usage"')
  expect(readFileSync(join(copyDir, "main.jsonl"), "utf8")).toContain(`{"role":"forked","text":"${id}"`)
  expect(readFileSync(join(copyDir, "kernel", "scope-1.ts"), "utf8")).toBe(`export * from "${copyDir}/kernel/cell-1.ts"\n`)
  expect(await Effect.runPromise(Effect.flip(forkSession(`${SESSIONS}/missing`)).pipe(Effect.provide(diskStore(home))))).toMatchObject({ _tag: "SessionError" })
  expect(existsSync(join(home, SESSIONS, "missing"))).toBe(false)
})
