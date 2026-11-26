import { expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { GraphMemory } from "../../src/base/graph-memory"
import { graphOnStore } from "../../src/plugins/graph"
import { ActiveAgent } from "../../src/base/memory"
import { diskStore, Store } from "../../src/base/store"
import { captureSessions, graphStats } from "../../src/learning/graph-capture"

const dirs = () => ({ home: mkdtempSync(join(tmpdir(), "empty-vessel-home-")), root: mkdtempSync(join(tmpdir(), "empty-vessel-proj-")) })

// Each call opens the graph afresh, as a cron run or a new process would.
const graphIn = (home: string, root: string) =>
  <A, E>(f: Effect.Effect<A, E, GraphMemory | Store>) =>
    Effect.runPromise(f.pipe(Effect.provide(graphOnStore(root).pipe(Layer.provideMerge(diskStore(home)))), Effect.provideService(ActiveAgent, "root"), Effect.scoped))

const line = (e: object) => JSON.stringify(e) + "\n"
const writeSession = (home: string, id: string, entries: ReadonlyArray<object>) => {
  mkdirSync(join(home, "sessions", id), { recursive: true })
  writeFileSync(join(home, "sessions", id, "main.jsonl"), entries.map(line).join(""))
}

// A fixture session: a user turn with a command, a check and a file effect, then a job's turn in a named agent.
const fixture = (root: string) => [
  { role: "project", text: root, ts: 1000 },
  { role: "user", text: "make the tests pass", ts: 1001 },
  { role: "command", text: "kernel", args: { summary: "Run the tests" }, output: "exit 1", ts: 1002 },
  { role: "effect", text: "write src/a.ts", id: "e1", cell: 1, ts: 1003 },
  { role: "effect", text: "write src/a.ts", id: "e1", outcome: "ok", cell: 1, ts: 1004 },
  { role: "check", text: "bun test", verdict: "passed", ts: 1005 },
  { role: "assistant", text: "The tests pass now.", ts: 1006 },
  { role: "agent", text: "reviewer", ts: 1007 },
  { role: "user", text: "the user wants weekly reports", origin: "cron", ts: 1008 },
  { role: "assistant", text: "Noted.", ts: 1009 },
]

const observations = (home: string, root: string) =>
  graphIn(home, root)(Effect.flatMap(GraphMemory, (gm) => gm.use((ops) =>
    ops.observations({ sourcePrefix: "session:", after: { at: -1, id: "" }, limit: 1000 }).toSorted((a, b) => (a.valid_from ?? 0) - (b.valid_from ?? 0)))))

test("capture: a fixture session becomes turn, command, effect and check observations, with project, agent and origin", async () => {
  const { home, root } = dirs()
  writeSession(home, "s1", fixture(root))

  const captured = await graphIn(home, root)(captureSessions)
  const seen = await observations(home, root)

  expect(captured).toEqual({ sessions: 1, observations: 5 })
  expect(seen.map((o) => [o.kind, o.text])).toEqual([
    ["command", "kernel: Run the tests"],
    ["effect", "write src/a.ts → ok"],
    ["check", "check passed: bun test"],
    ["turn", "make the tests pass → The tests pass now."],
    ["turn", "the user wants weekly reports → Noted."],
  ])
  const project = seen[0]!.attrs.project as string
  expect(seen[0]!.attrs).toEqual({ project, origin: "user" })
  expect(seen[4]!.attrs).toEqual({ project, origin: "cron", agent: "reviewer" })
  expect(seen[0]!).toMatchObject({ source: expect.stringMatching(/^session:s1#\d+$/), source_trust: "asserted", valid_from: 1002 })
  expect(new Set(seen.map((o) => o.source)).size).toBe(5)

  // One existence fact for the project, created on first sight.
  const existence = await graphIn(home, root)(Effect.flatMap(GraphMemory, (gm) => gm.use((ops) => ops.query({ attrs: { role: "existence" } }))))
  expect(existence.map((f) => f.text)).toEqual([project])
})

test("capture twice over the same sessions writes each observation once; a grown session adds only its new lines", async () => {
  const { home, root } = dirs()
  writeSession(home, "s1", fixture(root))
  const run = graphIn(home, root)

  await run(captureSessions)
  expect(await run(captureSessions)).toEqual({ sessions: 0, observations: 0 })

  appendFileSync(join(home, "sessions/s1/main.jsonl"), line({ role: "check", text: "bun run lint", verdict: "failed", ts: 1010 }) + '{"role":"check","te') // a torn last line waits
  expect(await run(captureSessions)).toEqual({ sessions: 1, observations: 1 })
  expect((await observations(home, root)).length).toBe(6)
})

test("two captures at once write each observation once", async () => {
  const { home, root } = dirs()
  writeSession(home, "s1", fixture(root))
  writeSession(home, "s2", fixture(root))

  const results = await Promise.all([graphIn(home, root)(captureSessions), graphIn(home, root)(captureSessions)])

  expect(results.reduce((n, r) => n + r.observations, 0)).toBe(10)
  expect((await observations(home, root)).length).toBe(10)
})

test("a session without effect lines still yields turn and command observations", async () => {
  const { home, root } = dirs()
  writeSession(home, "s1", fixture(root).filter((e) => e.role !== "effect"))

  await graphIn(home, root)(captureSessions)

  expect((await observations(home, root)).map((o) => o.kind)).toEqual(["command", "check", "turn", "turn"])
})

test("graph stats: counts by kind and status", async () => {
  const { home, root } = dirs()
  writeSession(home, "s1", fixture(root))
  await graphIn(home, root)(captureSessions)

  const stats = await graphIn(home, root)(graphStats)

  expect(stats).toBe(["check: 1 supported", "command: 1 supported", "effect: 1 supported", "project: 1 unverified", "turn: 2 supported"].join("\n"))
})
