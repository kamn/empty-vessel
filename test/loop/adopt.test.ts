import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { proposeTools } from "../../src/loop/adopt"
import { loadPool } from "../../src/loop/library"

test("proposed tools run in a fresh kernel and go through promote into the pool; a broken one is reported, not added", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "empty-vessel-adopt-")), "library")
  const results = await Effect.runPromise(proposeTools(dir, "session-1", {}, [
    { name: "wordCount", for: "systemTwo", description: "Counts words: wordCount(text) returns how many words text has", example: `wordCount("a b c")`, parameters: [], code: `export const wordCount = (text: string) => text.split(/\\s+/).filter(Boolean).length`, why: "counting comes up often" },
    { name: "broken", for: "systemOne", description: "Broken", example: "x", parameters: [], code: `export const broken = (goal: string) => { return goal.nope() }`, why: "" },
  ]))

  expect(results[0]).toContain("wordCount (systemTwo): added wordCount to the pool")
  expect(results[1]).toContain("broken (systemOne): not proposed: its cell failed (type-error)")
  expect(loadPool(dir)).toMatchObject([{ name: "wordCount", for: "systemTwo", from: "session-1" }])
})

test("proposeTools cleans up the kernel folder it tries each proposal in", async () => {
  const scratch = () => readdirSync(tmpdir()).filter((d) => d.startsWith("empty-vessel-proposal-")).length
  const dir = join(mkdtempSync(join(tmpdir(), "empty-vessel-adopt-")), "library")
  const before = scratch()
  await Effect.runPromise(proposeTools(dir, "session-1", {}, [
    { name: "wordCount", for: "systemTwo", description: "Counts words: wordCount(text)", example: `wordCount("a b")`, parameters: [], code: `export const wordCount = (text: string) => text.split(/\\s+/).filter(Boolean).length`, why: "" },
  ]))
  expect(scratch()).toBe(before)
})
