import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { projectInstructions } from "../../src/base/context"

test("projectInstructions: each AGENTS.md / CLAUDE.md as a block, most general folder first (what the loop hands System Two)", async () => {
  const root = mkdtempSync(join(tmpdir(), "empty-vessel-ctx-"))
  mkdirSync(join(root, "app"))
  writeFileSync(join(root, "CLAUDE.md"), "outer rule")
  writeFileSync(join(root, "app", "AGENTS.md"), "inner rule")
  const text = await Effect.runPromise(projectInstructions(join(root, "app")))
  expect(text.indexOf("outer rule")).toBeLessThan(text.indexOf("inner rule"))
  expect(text).toContain(`<project_instructions path="${join(root, "app", "AGENTS.md")}">\ninner rule\n</project_instructions>`)
})

test("nestedContextFiles: the AGENTS.md / CLAUDE.md of the folders below cwd holding the files, most general first, one per folder", async () => {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { nestedContextFiles } = await import("../../src/base/context")
  const root = mkdtempSync(join(tmpdir(), "empty-vessel-nested-"))
  mkdirSync(join(root, "packages/api/src"), { recursive: true })
  mkdirSync(join(root, "packages/web"), { recursive: true })
  writeFileSync(join(root, "AGENTS.md"), "root") // cwd's own: loadContextFiles has it already
  writeFileSync(join(root, "packages/AGENTS.md"), "all packages")
  writeFileSync(join(root, "packages/api/AGENTS.md"), "api")
  writeFileSync(join(root, "packages/api/CLAUDE.md"), "api (second name: not used)")
  writeFileSync(join(root, "packages/web/CLAUDE.md"), "web")

  expect(nestedContextFiles(root, ["packages/api/src/server.ts", "README.md"])).toEqual(["packages/AGENTS.md", "packages/api/AGENTS.md"])
  expect(nestedContextFiles(root, ["packages/web/x.ts", "packages/api/y.ts"])).toEqual(["packages/AGENTS.md", "packages/api/AGENTS.md", "packages/web/CLAUDE.md"])
  expect(nestedContextFiles(root, ["../elsewhere/z.ts"])).toEqual([])
})
