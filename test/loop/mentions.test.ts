import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { mentionedFiles, packMentioned } from "../../src/loop/mentions"

const project = () => {
  const root = mkdtempSync(join(tmpdir(), "empty-vessel-mentions-"))
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1\n")
  writeFileSync(join(root, "notes.md"), "# notes\n")
  writeFileSync(join(root, "blob.bin"), "x\0y")
  return root
}

test("mentionedFiles: @paths that are files, trailing punctuation dropped; folders, missing files and emails ignored", () => {
  const root = project()
  expect(mentionedFiles("fix @src/a.ts, then see @notes.md. Also @src @missing.ts and me@example.com", root)).toEqual(["src/a.ts", "notes.md"])
  expect(mentionedFiles(`@${join(root, "notes.md")}`, root)).toEqual(["notes.md"]) // absolute inside the project: relative
})

test("packMentioned: packs new files for System Two, skips ones it already has and binaries, and marks them given", async () => {
  const root = project()
  const given = new Set(["notes.md"])

  const { paths, packed } = await Effect.runPromise(packMentioned("look at @src/a.ts @notes.md @blob.bin", root, given))

  expect(paths).toEqual(["src/a.ts"])
  writeFileSync(join(root, "src", "AGENTS.md"), "src rules\n")
  expect((await Effect.runPromise(packMentioned("again @src/a.ts @src/b.ts", root, new Set()))).paths).toEqual(["src/AGENTS.md", "src/a.ts"]) // its folder's rules first
  expect(packed).toBe('<file path="src/a.ts">\nexport const a = 1\n\n</file>')
  expect([...given]).toEqual(["notes.md", "src/a.ts"])
})
