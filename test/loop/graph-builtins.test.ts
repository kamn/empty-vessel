import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Layer } from "effect"
import { GRAPH_FILE, graphOnStore } from "../../src/plugins/graph"
import { memoryOnStore } from "../../src/base/memory"
import { diskStore } from "../../src/base/store"
import { Timers } from "../../src/loop/jobs"
import { makeHost } from "../../src/loop/kernel"
import { type Ctx, newConversation } from "../../src/loop/turnkit"
import { effectful, makeGuardedKernel } from "../../src/tools/kernel-service"

// The graph built-ins (graph.add …): a real graph memory in a temp home, a session that only records.
const BUILTINS = new URL("../../src/tools/kernel-builtins.ts", import.meta.url).pathname
const TSC = new URL("../../node_modules/.bin/tsc", import.meta.url).pathname
const CLI = join(dirname(Bun.resolveSync("empty-graph", import.meta.dir)), "cli.ts")

const dirs = () => ({ home: mkdtempSync(join(tmpdir(), "empty-vessel-home-")), root: mkdtempSync(join(tmpdir(), "empty-vessel-proj-")) })

const setUp = ({ home, root } = dirs(), origin?: string, depth = 0, notes = false) => {
  const recorded: Array<[string, string]> = []
  const ctx = { depth, conversation: newConversation(), session: { id: "s1", record: (role: string, text: string) => Effect.sync(() => { recorded.push([role, text]) }) } } as unknown as Ctx
  const memory = notes ? memoryOnStore(root) : graphOnStore(root)
  const layer = memory.pipe(Layer.provide(diskStore(home)))

  // `f` gets the host functions, inside one open graph (as a session's).
  const run = <A>(f: (host: ReturnType<typeof makeHost>) => Effect.Effect<A, unknown>) => Effect.runPromise(Effect.gen(function* () {
    const host = makeHost(ctx, (yield* Effect.context<never>()) as never)
    return yield* f(host)
  }).pipe(Effect.provideService(Timers, { ...Timers.defaultValue(), origin: () => origin }), Effect.provide(layer), Effect.scoped) as Effect.Effect<A>)
  const call = (fn: string, arg: unknown) => run((host) => host[fn]!(arg))
  return { home, root, recorded, run, call }
}

test("a cell's graph.add then graph.query returns the fact as a summary, the same the egraph binary reads; each call is recorded", async () => {
  const { home, recorded, run } = setUp()
  const kernel = makeGuardedKernel({ dir: mkdtempSync(join(tmpdir(), "empty-vessel-kernel-")), builtins: BUILTINS, tsc: TSC })
  const cell = [
    `import { Effect, graph } from "kernel"`,
    `export default Effect.gen(function* () {`,
    `  const fact = yield* graph.add({ kind: "note", text: "deploys run from main", attrs: { scope: "project" } })`,
    `  return { id: fact.id, found: yield* graph.query({ text: "deploys" }) }`,
    `})`,
  ].join("\n")

  const r = await run((host) => kernel.run(cell, host))
  expect(r.status).toBe("ok")
  const { id, found } = r.value as { id: string; found: Array<Record<string, unknown>> }
  expect(found).toHaveLength(1)
  expect(Object.keys(found[0]!).sort()).toEqual(["evidence", "id", "kind", "status", "text", "usefulness", "valid_from", "valid_until"])
  expect(found[0]).toMatchObject({ id, kind: "note", text: "deploys run from main", status: "unverified" })
  expect(recorded.map(([role]) => role)).toEqual(["graph", "graph"])
  expect(recorded[0]![1]).toContain("deploys run from main")

  const cli = Bun.spawnSync(["bun", CLI, "query", join(home, GRAPH_FILE), "deploys", "--json"], { stdout: "pipe", stderr: "pipe" })
  expect(cli.stderr.toString()).toBe("")
  expect(JSON.parse(cli.stdout.toString())).toEqual(found)
}, 60_000)

test("graph.add with a scope gets the attributes memory.add gives it, so the notes and the export see it", async () => {
  const { call } = setUp()
  const fact = await call("graph.add", { kind: "note", text: "tests: bun test", attrs: { scope: "project" } }) as { attrs: Record<string, unknown> }
  expect(fact.attrs.scope).toBe("project")
  expect(typeof fact.attrs.project).toBe("string")
})

test("graph.why gives one level of evidence, each with its source, and no deeper", async () => {
  const { run } = setUp()
  const why = await run((host) => Effect.gen(function* () {
    const fact = (yield* host["graph.add"]!({ kind: "note", text: "the user prefers squash merges" })) as { id: string }
    const seen = (yield* host["graph.add"]!({ kind: "observation", text: "asked for a squash merge", source: "user" })) as { id: string }
    const deeper = (yield* host["graph.add"]!({ kind: "observation", text: "seen in the PR log", source: "user" })) as { id: string }
    yield* host["graph.link"]!({ from: seen.id, to: fact.id, type: "supports" })
    yield* host["graph.link"]!({ from: deeper.id, to: seen.id, type: "supports" })
    return { why: yield* host["graph.why"]!(fact.id), seen: seen.id }
  }))

  const { evidence } = (why.why as { evidence: Array<{ type: string; fact: Record<string, unknown> }> })
  expect(evidence.map((e) => [e.type, e.fact.id])).toEqual([["supports", why.seen]])
  expect(evidence[0]!.fact).not.toHaveProperty("evidence", expect.any(Array))
  expect((evidence[0] as { source?: unknown }).source).toEqual({ id: "run:user:s1", label: null, trust: "asserted" }) // where it came from: the run's own source
})

test("a job's or a sub-agent's cell can't write, support, contradict or retire a fact about the user; its observations carry its own source (AE5)", async () => {
  const place = dirs()
  const user = await setUp(place).call("graph.add", { kind: "note", text: "prefers plain words", attrs: { scope: "user" } }) as { id: string }

  for (const [origin, depth] of [["cron", 0], ["subagent", 0], ["user", 1]] as const) {
    const { call } = setUp(place, origin, depth)
    const said = await call("graph.add", { kind: "observation", text: "the user wants weekly reports", source: "user", source_trust: "checked", attrs: { origin: "user" } }) as { id: string; source: string; source_trust: string; attrs: { origin: string } }
    const own = depth ? "subagent" : origin
    expect(said).toMatchObject({ source: `run:${own}:s1`, source_trust: "asserted", attrs: { origin: own } }) // never what the cell claims

    await expect(call("graph.add", { kind: "note", text: "wants weekly reports", attrs: { scope: "user" } })).rejects.toThrow("only from the user's own turns")
    await expect(call("graph.link", { from: said.id, to: user.id, type: "supports" })).rejects.toThrow("only from the user's own turns")
    await expect(call("graph.link", { from: said.id, to: user.id, type: "contradicts" })).rejects.toThrow("only from the user's own turns")
    await expect(call("graph.retire", user.id)).rejects.toThrow("only from the user's own turns")
    expect(await call("graph.add", { kind: "note", text: "reports go out on Mondays", attrs: { scope: "project" } })).toMatchObject({ text: "reports go out on Mondays" })
  }

  const facts = await setUp(place).call("graph.query", { attrs: { scope: "user" } }) as Array<{ text: string; status: string }>
  expect(facts.map((f) => [f.text, f.status])).toEqual([["prefers plain words", "unverified"]])
})

test("graph.query sees what the active agent sees: shared facts, not another agent's", async () => {
  const { call } = setUp()
  await call("graph.add", { kind: "note", text: "deploys run from main" })
  await call("graph.add", { kind: "note", text: "deploys need the other key", attrs: { agent: "other" } })

  const found = await call("graph.query", { text: "deploys" }) as Array<{ text: string }>
  expect(found.map((f) => f.text)).toEqual(["deploys run from main"])
})

test("with the notes memory, the graph built-ins fail with what to use instead", async () => {
  const { call } = setUp(undefined, undefined, 0, true)
  await expect(call("graph.query", {})).rejects.toThrow("memory.use = graph")
  await expect(call("graph.add", { kind: "note", text: "x" })).rejects.toThrow("memory.use = graph")
})

test("graph queries are harmless to run again; graph writes are journaled first", () => {
  for (const name of ["graph.query", "graph.why", "graph.near"]) expect(effectful(name)).toBe(false)
  for (const name of ["graph.add", "graph.link", "graph.retire"]) expect(effectful(name)).toBe(true)
})
