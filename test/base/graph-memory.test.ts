import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { add, query, show, usage, why } from "empty-graph"
import { GraphMemory, graphOnStore } from "../../src/base/graph-memory"
import { ActiveAgent, Memory, MemoryPull } from "../../src/base/memory"
import { projectDir } from "../../src/base/project"
import { diskStore } from "../../src/base/store"

const dirs = () => ({ home: mkdtempSync(join(tmpdir(), "empty-vessel-home-")), root: mkdtempSync(join(tmpdir(), "empty-vessel-proj-")) })
const project = (root: string) => projectDir(root, "").replace(/^projects\//, "")

// Each call opens the graph afresh (as a new session would), as `agent`.
const graphIn = (home: string, root: string) =>
  <A, E>(f: Effect.Effect<A, E, Memory | GraphMemory>, agent = "root") =>
    Effect.runPromise(f.pipe(Effect.provide(graphOnStore(root).pipe(Layer.provide(diskStore(home)))), Effect.provideService(ActiveAgent, agent), Effect.scoped))
const pulled = (goal: string) => Effect.gen(function* () { return yield* (yield* MemoryPull).candidates!(goal) })

// Today's notes, in every scope: the profile, empty-vessel's own, a named agent's, this project's and another project's.
const writeNotes = (home: string, root: string) => {
  const files: Record<string, string> = {
    "agents/user.md": "- prefers short answers\n- lives in Porto\n",
    "agents/memory.md": "- rg isn't installed: use grep\n",
    "agents/reviewer/memory.md": "- report problems most serious first\n",
    [`projects/${project(root)}/learned.md`]: "- tests: bun test\n- Node 24 via .nvmrc\n",
    "projects/other-repo/learned.md": "- deploys from release\n",
  }
  for (const [key, text] of Object.entries(files)) {
    mkdirSync(join(home, key, ".."), { recursive: true })
    writeFileSync(join(home, key), text)
  }
  return files
}

test("first open migrates every scope's notes into note facts with scope, agent and project, each backed by a migration observation", async () => {
  const { home, root } = dirs()
  writeNotes(home, root)
  const run = graphIn(home, root)

  const facts = await run(Effect.flatMap(GraphMemory, (gm) => gm.use((g) => query(g, { kind: "note", limit: 100 }).map((s) => ({ ...show(g, s.id)!, why: why(g, s.id)! })))))
  const attrsOf = (text: string) => facts.find((f) => f.text === text)?.attrs

  expect(facts.length).toBe(7)
  expect(attrsOf("prefers short answers")).toEqual({ scope: "user" }) // the user-scope guard keys on this (KTD15)
  expect(attrsOf("rg isn't installed: use grep")).toEqual({ scope: "agent" })
  expect(attrsOf("report problems most serious first")).toEqual({ scope: "agent", agent: "reviewer" })
  expect(attrsOf("tests: bun test")).toEqual({ scope: "project", project: project(root) })
  expect(attrsOf("deploys from release")).toEqual({ scope: "project", project: "other-repo" })
  for (const f of facts) {
    expect(f.why.evidence.length).toBe(1)
    expect(f.why.evidence[0]).toMatchObject({ type: "supports", fact: { kind: "observation" } })
  }
})

// Lossy only in ordering: facts learned in the same millisecond export in id order.
test("export after migration reproduces the notes files, line for line", async () => {
  const { home, root } = dirs()
  const files = writeNotes(home, root)
  const run = graphIn(home, root)

  const exported = await run(Effect.flatMap(GraphMemory, (gm) => gm.exportNotes))

  const sorted = (r: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.split("\n").sort()]))
  expect(sorted(exported)).toEqual(sorted(files))
})

test("migration runs once: a second open, or notes written later, migrate nothing more", async () => {
  const { home, root } = dirs()
  writeNotes(home, root)
  const run = graphIn(home, root)
  const count = Effect.flatMap(GraphMemory, (gm) => gm.use((g) => query(g, { kind: "note", limit: 100 }).length))

  expect(await run(count)).toBe(7)
  writeFileSync(join(home, "agents/memory.md"), "- rg isn't installed: use grep\n- a later line\n")
  expect(await run(count)).toBe(7)
})

// Two processes opening an empty graph at once: the meta marker, checked inside one immediate transaction, lets one migrate.
test("two processes opening an empty graph at once migrate the notes once", async () => {
  const { home, root } = dirs()
  writeNotes(home, root)
  const script = `import { Effect, Layer } from "effect"; import { query } from "empty-graph"; import { GraphMemory, graphOnStore } from "./src/base/graph-memory"; import { diskStore } from "./src/base/store"
    await Effect.runPromise(Effect.flatMap(GraphMemory, (gm) => gm.use((g) => query(g, {}).length)).pipe(Effect.provide(graphOnStore(${JSON.stringify(root)}).pipe(Layer.provide(diskStore(${JSON.stringify(home)})))), Effect.scoped))`
  const spawn = () => Bun.spawn(["bun", "-e", script], { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" })

  const both = [spawn(), spawn()]
  await Promise.all(both.map((p) => p.exited))

  expect(both.map((p) => p.exitCode)).toEqual([0, 0])
  expect(await graphIn(home, root)(Effect.flatMap(GraphMemory, (gm) => gm.use((g) => query(g, { kind: "note", limit: 100 }).length)))).toBe(7)
})

test("a named agent sees its own facts and the shared ones, not another agent's; empty-vessel doesn't see a named agent's", async () => {
  const { home, root } = dirs()
  writeNotes(home, root)
  const run = graphIn(home, root)
  await run(Effect.flatMap(Memory, (m) => m.add("agent", "the deploy key is in 1Password")), "deployer")

  const reviewer = (await run(pulled("anything"), "reviewer")).map((c) => c.text)
  const own = await run(Effect.flatMap(Memory, (m) => m.entries("agent")), "reviewer")
  const snapshot = await run(Effect.flatMap(Memory, (m) => m.snapshot), "reviewer")

  expect(reviewer).toContain("report problems most serious first")
  expect(reviewer).toContain("rg isn't installed: use grep")
  expect(reviewer).toContain("prefers short answers")
  expect(reviewer).toContain("tests: bun test")
  expect(reviewer).not.toContain("the deploy key is in 1Password")
  expect(reviewer).not.toContain("deploys from release") // another project's
  expect(own).toEqual(["- report problems most serious first"])
  expect(snapshot).toContain("As the reviewer agent:\n- report problems most serious first")
  expect((await run(pulled("anything"))).map((c) => c.text)).not.toContain("report problems most serious first")
})

test("memory.add creates a fact GraphMemory.query reads; replace ends the old one; remove retires it", async () => {
  const { home, root } = dirs()
  const run = graphIn(home, root)
  const texts = Effect.flatMap(GraphMemory, (gm) => gm.use((g) => query(g, { text: "bun" }).map((s) => s.text)))

  await run(Effect.flatMap(Memory, (m) => m.add("project", "tests run with bun test")))
  expect(await run(texts)).toEqual(["tests run with bun test"])

  await run(Effect.flatMap(Memory, (m) => m.replace("project", "bun test", "tests run with bun run test")))
  expect(await run(texts)).toEqual(["tests run with bun run test"])
  expect(await run(Effect.flatMap(Memory, (m) => m.entries("project")))).toEqual(["- tests run with bun run test"])

  await run(Effect.flatMap(Memory, (m) => m.remove("project", "bun run test")))
  expect(await run(texts)).toEqual([])
  expect(await run(Effect.flip(Effect.flatMap(Memory, (m) => m.remove("project", "nothing like this"))))).toMatchObject({ message: 'no project entries contain "nothing like this"' })
})

test("pull candidates: FTS matches on the goal first, then the top facts; never observations or existence facts; usage credits the picked", async () => {
  const { home, root } = dirs()
  writeNotes(home, root)
  const run = graphIn(home, root)
  await run(Effect.flatMap(GraphMemory, (gm) => gm.use((g) => add(g, { kind: "note", text: "the parser lives in src/parse.ts", attrs: { role: "existence" } }))))

  const candidates = await run(pulled("why do the tests fail with Node"))

  expect(candidates.slice(0, 2).map((c) => c.text).sort()).toEqual(["Node 24 via .nvmrc", "tests: bun test"]) // the goal's words match these
  expect(candidates.map((c) => c.text)).toContain("prefers short answers") // not a match, but the top facts fill in
  expect(candidates.map((c) => c.text)).not.toContain("the parser lives in src/parse.ts")
  expect(candidates.every((c) => c.kind === "note")).toBe(true) // no observations

  const [picked, other] = candidates
  await run(Effect.gen(function* () { yield* (yield* MemoryPull).reportUsage!({ shown: candidates.map((c) => c.id), picked: [picked!.id], outcome: "done" }) }))
  const counts = await run(Effect.flatMap(GraphMemory, (gm) => gm.use((g) => [usage(g, picked!.id), usage(g, other!.id)])))
  expect(counts[0]).toMatchObject({ shown: 1, picked: 1, good: 1, bad: 0 })
  expect(counts[1]).toMatchObject({ shown: 1, picked: 0, good: 0, bad: 0 })
})

test("pull candidates: a note still shows among far more captured observations", async () => {
  const { home, root } = dirs()
  const run = graphIn(home, root)
  await run(Effect.flatMap(GraphMemory, (gm) => gm.use((g) => {
    add(g, { kind: "note", text: "tests: bun test", attrs: { scope: "project" } })
    for (let i = 0; i < 130; i++) add(g, { kind: "turn", text: `run the tests → tests pass ${i}`, source: `session:s1#${i}`, source_trust: "asserted", attrs: { origin: "user" } })
  })))

  expect((await run(pulled("run the tests"))).map((c) => c.text)).toEqual(["tests: bun test"])
})
