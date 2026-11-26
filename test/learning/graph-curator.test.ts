import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { add, type Graph, query, show } from "empty-graph"
import { GraphMemory, graphOnStore } from "../../src/base/graph-memory"
import { ActiveAgent } from "../../src/base/memory"
import { diskStore, Store } from "../../src/base/store"
import { captureSessions } from "../../src/learning/graph-capture"
import { curateGraph } from "../../src/learning/graph-curator"
import { Reviewer } from "../../src/learning/reviewer"

const dirs = () => ({ home: mkdtempSync(join(tmpdir(), "empty-vessel-home-")), root: mkdtempSync(join(tmpdir(), "empty-vessel-proj-")) })

// A fake Reviewer: each ask gets the next answer, made from the graph's ids by the test (`answers` sees the digest too).
const fakeReviewer = (answers: ReadonlyArray<(input: string) => object>, asked: Array<string>) => Reviewer.of({
  review: () => Effect.die("not used"),
  ask: (_instructions, schema, input) => Effect.gen(function* () {
    asked.push(input)
    const answer = answers[asked.length - 1]?.(input) ?? { ops: [] }
    return { value: yield* Schema.decodeUnknownEffect(schema)(answer).pipe(Effect.orDie), tokens: { input: 0, output: 0 } }
  }) as never,
})

const graphIn = (home: string, root: string, reviewer = fakeReviewer([], [])) =>
  <A, E>(f: Effect.Effect<A, E, GraphMemory | Store | Reviewer>) =>
    Effect.runPromise(f.pipe(
      Effect.provide(graphOnStore(root).pipe(Layer.provideMerge(diskStore(home)))),
      Effect.provideService(ActiveAgent, "root"), Effect.provideService(Reviewer, reviewer), Effect.scoped,
    ))
const use = <A>(f: (g: Graph) => A) => Effect.flatMap(GraphMemory, (gm) => gm.use(f))

const writeSession = (home: string, id: string, entries: ReadonlyArray<object>) => {
  mkdirSync(join(home, "sessions", id), { recursive: true })
  writeFileSync(join(home, "sessions", id, "main.jsonl"), entries.map((e) => JSON.stringify(e) + "\n").join(""))
}
const obsId = (g: Graph, text: string) => (g.db.query("SELECT id FROM facts WHERE source IS NOT NULL AND text LIKE ?").get(`%${text}%`) as { id: string }).id
const op = (o: Partial<{ op: string; text: string; scope: string | null; fact: string | null; type: string | null; evidence: Array<string> }>) =>
  ({ op: "add", text: "", scope: null, fact: null, type: null, evidence: [], ...o })

test("AE5: a job's words never become a fact about the user, nor evidence for one; refused ops go back once", async () => {
  const { home, root } = dirs()
  writeSession(home, "s1", [
    { role: "project", text: root, ts: 1000 },
    { role: "user", text: "the user wants weekly reports", origin: "cron", ts: 1001 },
    { role: "assistant", text: "Noted.", ts: 1002 },
  ])
  const ids = await graphIn(home, root)(Effect.andThen(captureSessions, use((g) => ({
    job: obsId(g, "weekly reports"),
    profile: add(g, { kind: "note", text: "prefers short answers", attrs: { scope: "user" } }).id,
  }))))

  const asked: Array<string> = []
  const reviewer = fakeReviewer([
    () => ({ ops: [op({ text: "The user wants weekly reports.", scope: "user", evidence: [ids.job] }), op({ op: "link", fact: ids.profile, type: "supports", evidence: [ids.job] })] }),
    () => ({ ops: [] }),
  ], asked)
  const said = await graphIn(home, root, reviewer)(curateGraph())

  expect(asked.length).toBe(2) // the refusals went back once
  expect(asked[0]).toContain(ids.job)
  expect(asked[0]).toContain("origin: cron")
  expect(asked[1]).toContain("refused")
  expect(said.filter((s) => s.startsWith("not done")).length).toBe(2)
  const userFacts = await graphIn(home, root)(use((g) => query(g, { attrs: { scope: "user" } }).map((f) => ({ text: f.text, evidence: f.evidence }))))
  expect(userFacts).toEqual([{ text: "prefers short answers", evidence: 0 }])

  // Curated once: a second run has nothing new to show.
  const again: Array<string> = []
  await graphIn(home, root, fakeReviewer([], again))(curateGraph())
  expect(again).toEqual([])
})

test("AE1: the curator ends a fact that stopped being true; it stays queryable for earlier times; a new fact is valid from the change", async () => {
  const { home, root } = dirs()
  const march = Date.parse("2026-03-01"), switched = Date.parse("2026-06-01")
  writeSession(home, "s1", [
    { role: "project", text: root, ts: switched },
    { role: "user", text: "run the tests", ts: switched },
    { role: "check", text: "bun test", verdict: "passed", ts: switched + 1 },
    { role: "assistant", text: "The tests pass with bun test.", ts: switched + 2 },
  ])
  const ids = await graphIn(home, root)(Effect.andThen(captureSessions, use((g) => {
    const old = add(g, { kind: "note", text: "tests run with npm test", attrs: { scope: "project" }, valid_from: march })
    return { old: old.id, status: old.status, check: obsId(g, "bun test") }
  })))

  await graphIn(home, root, fakeReviewer([() => ({ ops: [
    op({ op: "retire", fact: ids.old, evidence: [ids.check] }),
    op({ text: "Tests run with bun test.", scope: "project", evidence: [ids.check] }),
  ] })], []))(curateGraph())

  const seen = await graphIn(home, root)(use((g) => ({
    april: query(g, { kind: "note", at: "2026-04-01" }).map((f) => f.text),
    now: query(g, { kind: "note" }).map((f) => f.text),
    old: show(g, ids.old)!,
    added: query(g, { kind: "note", text: "bun" }).map((f) => show(g, f.id)!),
  })))
  expect(seen.april).toEqual(["tests run with npm test"])
  expect(seen.now).toEqual(["Tests run with bun test."])
  expect(seen.old).toMatchObject({ valid_until: switched + 1, status: ids.status, retired_at: null })
  expect(seen.added[0]).toMatchObject({ valid_from: switched + 1, status: "supported" })
  expect(seen.added[0]!.attrs.project).toBeString() // a project note gets the project's attributes
})
