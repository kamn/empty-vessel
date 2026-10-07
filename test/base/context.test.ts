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
