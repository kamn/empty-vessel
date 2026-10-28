import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import type { CompactOptions } from "../../src/system-two/systemtwo"
import { FakeFill, Fill } from "../../src/system-two/fill"
import { discoverSkills } from "../../src/base/skills"
import { compactCommand, compactIfNeeded } from "../../src/loop/compact"
import { loadConversation, switchConversation } from "../../src/loop/resume"
import { skillContext, skillNotes } from "../../src/loop/skills"
import { type Ctx, newConversation } from "../../src/loop/turnkit"

const dirs: string[] = []
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-lifecycle-"))
  dirs.push(dir)
  const home = join(dir, "home"), project = join(dir, "project")
  const skill = join(project, ".empty-vessel/skills/testing")
  mkdirSync(skill, { recursive: true })
  mkdirSync(home)
  writeFileSync(join(skill, "SKILL.md"), "---\nname: testing\ndescription: Test changes\n---\nSECRET BODY\n")
  const c = newConversation()
  c.skills = discoverSkills(project, home)
  c.skillCatalogPending = true
  return { dir, home, project, skill, c }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test("catalog is metadata only, emitted once; refresh appends without rewriting briefing", () => {
  const { c, project, home, skill } = fixture()
  c.briefing = "project instructions"
  const first = skillNotes(c, true, project).join("\n")
  expect(first).toContain("testing")
  expect(first).not.toContain("SECRET BODY")
  expect(skillNotes(c, true, project)).toEqual([])

  writeFileSync(join(skill, "SKILL.md"), "---\nname: testing\ndescription: Refreshed description\n---\nNEW BODY\n")
  c.skills = discoverSkills(project, home)
  c.skillCatalogPending = true
  expect(skillNotes(c, true, project).join("\n")).toContain("Refreshed description")
  expect(c.briefing).toBe("project instructions")

  rmSync(skill, { recursive: true })
  c.skills = discoverSkills(project, home)
  c.skillCatalogPending = true
  expect(skillNotes(c, true, project).join("\n")).toContain("no model-invocable skills")
  expect(skillNotes(c, true, project)).toEqual([])
})

test("file grants suppress discovery, not saved replay; fresh child does not inherit loaded bodies", () => {
  const { c, project } = fixture()
  c.activeSkills = { testing: "saved body" }
  c.activeSkillsPending = true
  const replay = skillNotes(c, false, project).join("\n")
  expect(replay).toContain("saved body")
  expect(replay).not.toContain("Available skills")
  expect(c.activeSkillsPending).toBe(false)
  expect(skillContext(c, false)).toContain("saved body")
  expect(skillContext(c, true)).not.toContain("SECRET BODY")
  expect(skillNotes(c, true, project).join("\n")).toContain("testing")
  const child = newConversation()
  child.skills = c.skills
  child.skillCatalogPending = true
  expect(skillNotes(child, true, project).join("\n")).not.toContain("saved body")
  expect(child.activeSkills).toBeUndefined()
})

test("resume restores last saved activation even after compacted thread or missing source", () => {
  const { dir, c, project, skill } = fixture()
  writeFileSync(join(dir, "main.jsonl"), [
    { role: "skill", text: "testing", content: "old invocation" },
    { role: "compact", thread: [] },
    { role: "skill", text: "testing", content: "saved body with arguments and provenance" },
    { role: "skill", text: "invalid", content: null },
  ].map((entry) => JSON.stringify(entry)).join("\n"))
  rmSync(skill, { recursive: true })
  const resumed = loadConversation(dir)
  resumed.skills = c.skills
  expect(resumed.activeSkills).toEqual({ testing: "saved body with arguments and provenance" })
  expect(skillNotes(resumed, true, project).join("\n")).toContain("saved body with arguments and provenance")
  expect(skillNotes(resumed, true, project)).toEqual([])
})

test("provider handover replays catalog and loaded instructions only once", () => {
  const { dir, project, c } = fixture()
  skillNotes(c, true, project)
  c.activeSkills = { testing: "saved body" }
  switchConversation(c, dir)
  const notes = skillNotes(c, true, project).join("\n")
  expect(notes).toContain("testing")
  expect(notes).toContain("saved body")
  expect(skillNotes(c, true, project)).toEqual([])
})

test("actual compaction marks loaded instructions for replay even if all outputs disappear", async () => {
  const { c, project } = fixture()
  skillNotes(c, true, project)
  c.activeSkills = { testing: "saved instructions" }
  c.size = 200
  c.thread.push({ output: "old tool output" })
  const records: string[] = []
  const ctx = {
    conversation: c,
    config: { compactAt: 100 },
    systemTwo: { compact: (thread: unknown[]) => {
      thread.length = 0
      return Effect.succeed({ masked: 1, savedTokens: 180, summarized: 1, after: 20, tokens: { input: 0, output: 0 } })
    } },
    usage: { add: () => Effect.void },
    session: { record: (role: string) => Effect.sync(() => { records.push(role) }) },
    depth: 0,
  } as unknown as Ctx
  await Effect.runPromise(compactIfNeeded(ctx))
  expect(records).toContain("compact")
  expect(c.thread).toEqual([])
  expect(skillNotes(c, true, project).join("\n")).toContain("saved instructions")
  expect(skillNotes(c, true, project)).toEqual([])
})

// A compaction ctx whose System Two compact asks `summarize` about `cells` and records what came back.
const summarizing = (c: ReturnType<typeof fixture>["c"], cells: number) => {
  const got: Array<ReadonlyArray<string | undefined>> = [], records: string[] = [], usage: string[] = []
  const ctx = {
    conversation: c,
    config: { compactAt: 100 },
    systemOne: { judge: () => Effect.die("System One isn't asked during compaction") },
    systemTwo: { compact: (_: unknown[], { summarize }: CompactOptions) => Effect.gen(function* () {
      got.push(yield* summarize(Array.from({ length: cells }, (_, i) => ({ intent: `Cell ${i}`, glimpse: `out ${i}` }))))
      return { compressed: cells, stubbed: 0, reasoning: 0, summarized: 0, after: 40, tokens: { input: 0, output: 0 } }
    }) },
    usage: { add: (who: string) => Effect.sync(() => { usage.push(who) }) },
    session: { record: (role: string) => Effect.sync(() => { records.push(role) }) },
    depth: 0,
  } as unknown as Ctx
  return { ctx, got, records, usage }
}
const echoFill = (calls: Array<number>) => Layer.succeed(Fill, {
  fill: (_name, schema, _goal) => Effect.sync(() => {
    const keys = Object.keys((schema as any).fields)
    calls.push(keys.length)
    return { args: Object.fromEntries(keys.map((k) => [k, `result ${k}`])) as any, tokens: { input: 10, output: 5 } }
  }),
})

test("compaction gets each cell's result from the fill model, 40 cells per call, metered as fill; System One isn't asked", async () => {
  const { c } = fixture()
  c.size = 200
  const calls: number[] = []
  const { ctx, got, records, usage } = summarizing(c, 90)

  await Effect.runPromise(compactIfNeeded(ctx).pipe(Effect.provide(echoFill(calls))))
  expect(calls).toEqual([40, 40, 10])
  expect(got[0]).toHaveLength(90)
  expect(got[0]![0]).toBe("result c0")
  expect(got[0]![41]).toBe("result c1") // the second chunk's second cell
  expect(usage.filter((u) => u === "fill")).toHaveLength(3)
  expect(records).toContain("compact")
})

test("no fill model (or it fails): compaction still runs, the cells just get no result summary", async () => {
  const { c } = fixture()
  c.size = 200
  const { ctx, got, records } = summarizing(c, 3)
  await Effect.runPromise(compactIfNeeded(ctx).pipe(Effect.provide(FakeFill)))
  expect(got[0]).toEqual([undefined, undefined, undefined])
  expect(records).toContain("compact")
})

test("/compact: the next turn compacts even below compactAt, aiming for half the size; then it's back to the threshold", async () => {
  const { c } = fixture()
  expect(await Effect.runPromise(compactCommand(c))).toStartWith("Nothing to compact yet")
  c.size = 60
  const targets: number[] = []
  const ctx = {
    conversation: c,
    config: { compactAt: 100 },
    systemTwo: { compact: (_: unknown[], { target }: { target: number }) => {
      targets.push(target)
      return Effect.succeed({ compressed: 0, stubbed: 0, reasoning: 0, summarized: 1, after: 25, tokens: { input: 0, output: 0 } })
    } },
    usage: { add: () => Effect.void },
    session: { record: () => Effect.void },
    depth: 0,
  } as unknown as Ctx

  await Effect.runPromise(compactIfNeeded(ctx))
  expect(targets).toEqual([]) // below compactAt, not asked: nothing

  expect(await Effect.runPromise(compactCommand(c))).toContain("when you send your next message")
  await Effect.runPromise(compactIfNeeded(ctx))
  expect(targets).toEqual([30])
  expect(c.size).toBe(25)

  await Effect.runPromise(compactIfNeeded(ctx))
  expect(targets).toEqual([30]) // asked once
})
