import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Config, ConfigSchema } from "../../src/base/config"
import { memoryCommand } from "../../src/learning/notes"
import { diskStore } from "../../src/base/store"
import { ActiveAgent, Memory, memoryOnStore } from "../../src/base/memory"

const memoryIn = (home: string, root: string, limits = { agent: 400, project: 400 }) =>
  <A, E>(f: (m: Memory["Service"]) => Effect.Effect<A, E>, agent = "root") =>
    Effect.runPromise(Effect.flatMap(Memory, f).pipe(Effect.provide(memoryOnStore(root, limits).pipe(Layer.provide(diskStore(home)))), Effect.provideService(ActiveAgent, agent)))

test("memory: entries are added, replaced and removed by the text they contain; the snapshot labels each scope", async () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-")), root = mkdtempSync(join(tmpdir(), "empty-vessel-proj-"))
  const run = memoryIn(home, root)

  await run((m) => Effect.all([m.add("agent", "prefers short answers"), m.add("agent", "lives in Lisbon"), m.add("project", "tests run with bun test")]))
  await run((m) => m.replace("agent", "Lisbon", "lives in Porto"))
  await run((m) => m.remove("project", "bun test"))

  expect(await run((m) => m.snapshot)).toBe("How empty-vessel works with the user:\n- prefers short answers\n- lives in Porto")
  expect(readFileSync(join(home, "agents/memory.md"), "utf8")).toContain("lives in Porto") // empty-vessel's own, in the agents folder
  expect(await run((m) => Effect.flip(m.remove("agent", "nothing like this")))).toMatchObject({ message: 'no agent entries contain "nothing like this"' })
  expect(await run((m) => Effect.flip(m.remove("agent", "e")))).toMatchObject({ message: 'several agent entries contain "e"' })
})

// A named agent keeps its own notes in its folder and reads empty-vessel's (the root's) first.
test("a named agent writes its own memory and sees empty-vessel's; empty-vessel doesn't see the agent's", async () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-")), root = mkdtempSync(join(tmpdir(), "empty-vessel-proj-"))
  const run = memoryIn(home, root)

  await run((m) => m.add("agent", "the user wants plain words"))
  await run((m) => m.add("agent", "report problems most serious first"), "reviewer")
  await run((m) => m.add("project", "tests: pnpm test"), "reviewer")

  expect(await run((m) => m.snapshot, "reviewer")).toBe("How empty-vessel works with the user:\n- the user wants plain words\n\nAs the reviewer agent:\n- report problems most serious first\n\nAbout this project:\n- tests: pnpm test")
  expect(await run((m) => m.snapshot)).not.toContain("most serious first")
  expect(existsSync(join(home, "agents/reviewer/memory.md"))).toBe(true)
})

// The old scopes (user.md, machine notes in learned.md) move into empty-vessel's own memory once, all of it, even over the
// limit; the old files stay where they were.
test("migration: the old user and machine notes become empty-vessel's, once and whole", async () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-")), root = mkdtempSync(join(tmpdir(), "empty-vessel-proj-"))
  writeFileSync(join(home, "user.md"), "- prefers short answers\n")
  writeFileSync(join(home, "learned.md"), `- rg isn't installed: use grep\n- ${"x".repeat(60)}\n`)
  const run = memoryIn(home, root, { agent: 40, project: 400 })

  expect(await run((m) => m.entries("agent"))).toEqual(["- prefers short answers", "- rg isn't installed: use grep", `- ${"x".repeat(60)}`])
  expect(existsSync(join(home, "user.md")) && existsSync(join(home, "learned.md"))).toBe(true)
  expect(await run((m) => Effect.flip(m.add("agent", "one more")))).toMatchObject({ message: expect.stringContaining("agent memory is full") })

  await run((m) => m.remove("agent", "xxxx"))
  writeFileSync(join(home, "user.md"), "- prefers short answers\n- a later line, never moved\n") // only once
  expect(await run((m) => m.entries("agent"))).toEqual(["- prefers short answers", "- rg isn't installed: use grep"])
})

// Each scope has a size limit (Hermes's rule): over it, a write fails until entries are merged or removed; a file
// already over (from before limits) still loads, and a write that makes it smaller is allowed.
test("memory's limit: an add over it fails saying how full; a replace that shrinks fits; an over-limit file still loads", async () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-")), root = mkdtempSync(join(tmpdir(), "empty-vessel-proj-"))
  const run = <A, E>(f: (m: Memory["Service"]) => Effect.Effect<A, E>, limits = { agent: 40, project: 40 }) => memoryIn(home, root, limits)(f)

  await run((m) => m.add("project", "tests need APP_MODE=test")) // 27 characters with "- " and the newline
  expect(await run((m) => Effect.flip(m.add("project", "use Node 24 via PATH")))).toMatchObject({ message: "project memory is full (50 of 40 characters): merge or remove an entry first" })

  await run((m) => m.replace("project", "APP_MODE", "tests: APP_MODE=test; Node 24")) // grows, but still fits
  expect(await run((m) => m.snapshot)).toBe("About this project:\n- tests: APP_MODE=test; Node 24")

  // Over the limit already (a smaller limit now): it loads; a bigger write fails; a smaller one is allowed.
  const tight = { agent: 40, project: 20 }
  expect(await run((m) => m.snapshot, tight)).toContain("APP_MODE")
  expect(await run((m) => Effect.flip(m.replace("project", "Node", "tests: APP_MODE=test; Node 24 via nvm")), tight)).toMatchObject({ message: expect.stringContaining("project memory is full") })
  await run((m) => m.replace("project", "Node", "APP_MODE=test"), tight)
  expect(await run((m) => m.snapshot, tight)).toBe("About this project:\n- APP_MODE=test")
})

// empty-vessel memory: each scope with how full it is and its entries numbered; remove <scope> <n>; edit says where it is.
test("empty-vessel memory lists each scope numbered with how full it is; remove takes a number; edit says where the file is", async () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-")), root = mkdtempSync(join(tmpdir(), "empty-vessel-proj-"))
  const config = Schema.decodeUnknownSync(ConfigSchema)({ memory: { agentChars: 100, projectChars: 200 } })
  const command = (args: string) =>
    Effect.runPromise(memoryCommand(args).pipe(Effect.provide(memoryOnStore(root, { agent: 100, project: 200 }).pipe(Layer.provide(diskStore(home)))), Effect.provideService(Config, config)))
  const run = memoryIn(home, root)
  await run((m) => Effect.all([m.add("project", "tests: APP_MODE=test bun test"), m.add("project", "Node 24 via .nvmrc"), m.add("agent", "plain words")]))

  const list = await command("")
  expect(list).toContain("agent (14 of 100 characters)")
  expect(list).toContain("project (53 of 200 characters)")
  expect(list).toContain("  1. tests: APP_MODE=test bun test\n  2. Node 24 via .nvmrc")

  expect(await command("remove project 2")).toBe("forgot (project): Node 24 via .nvmrc")
  expect(await command("remove project 5")).toBe("no entry 5 in project memory (empty-vessel memory lists them)")
  expect(await command("remove team 1")).toContain("which scope?")
  expect(await command("edit agent")).toContain("agents/memory.md")
})
