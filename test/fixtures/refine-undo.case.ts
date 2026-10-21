import { expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { EMPTY_VESSEL_HOME } from "../../src/base/home"
import { Memory } from "../../src/base/memory"
import { projectDir } from "../../src/base/project"
import { libraryDir, loadPool, savePool } from "../../src/loop/library"
import { undo } from "../../src/loop/refine"

// Run only in a child whose EMPTY_VESSEL_HOME is a temporary folder (test/loop/refine.test.ts).
if (!EMPTY_VESSEL_HOME.startsWith(tmpdir()) && !EMPTY_VESSEL_HOME.includes("/T/")) throw new Error("refine-undo.case.ts needs a temporary EMPTY_VESSEL_HOME")

const tool = (dir: string, name: string, from: string, code: string) => {
  const file = join(dir, `${name}.ts`)
  writeFileSync(file, code)
  return { name, description: name, file, from, for: "systemTwo" as const }
}
const run = (root: string, id: string) => Effect.runPromise(undo(root, id).pipe(Effect.provideService(Memory, {} as never))) // a tool undo never touches memory
const log = (root: string, line: object) => { mkdirSync(projectDir(root), { recursive: true }); appendFileSync(join(projectDir(root), "refine.jsonl"), `${JSON.stringify(line)}\n`) }

test("refine undo of a tool puts back the pool tool it replaced, and leaves a newer one someone else added", async () => {
  const root = mkdtempSync(join(tmpdir(), "empty-vessel-refine-undo-")), dir = libraryDir(root)
  mkdirSync(dir, { recursive: true })
  const old = tool(dir, "shout", "session-a", "export const shout = 'old'")
  const theirs = tool(dir, "whisper", "session-b", "export const whisper = 'theirs'")
  savePool(dir, [tool(dir, "shout", "refine 9", "export const shout = 'new'"), theirs])
  writeFileSync(old.file, "export const shout = 'new'") // the refine's promote overwrote the module
  log(root, { id: "9.1", kind: "tool", what: "shout", outcome: "replacing", applied: true, trigger: "", name: "shout", from: "refine 9", replaced: { entry: old, code: "export const shout = 'old'" }, at: 1 })
  log(root, { id: "9.2", kind: "tool", what: "whisper", outcome: "added", applied: true, trigger: "", name: "whisper", from: "refine 9", at: 1 })

  expect(await run(root, "9.1")).toContain("undid 9.1")
  expect(loadPool(dir).find((e) => e.name === "shout")?.from).toBe("session-a")
  expect(readFileSync(old.file, "utf8")).toBe("export const shout = 'old'")

  expect(await run(root, "9.2")).toContain("has been replaced since (by session-b)")
  expect(loadPool(dir).find((e) => e.name === "whisper")?.from).toBe("session-b")
})
