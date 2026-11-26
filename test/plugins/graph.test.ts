import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { query, show, why } from "empty-graph"
import { Config, ConfigSchema } from "../../src/base/config"
import { GraphMemory, graphOnStore } from "../../src/base/graph-memory"
import { Memory, memoryOnStore } from "../../src/base/memory"
import { diskStore } from "../../src/base/store"
import { briefing, memoryCommand } from "../../src/learning/notes"

const dirs = () => ({ home: mkdtempSync(join(tmpdir(), "empty-vessel-home-")), root: mkdtempSync(join(tmpdir(), "empty-vessel-proj-")) })
const config = Schema.decodeUnknownSync(ConfigSchema)({})
const withGraph = (home: string, root: string) =>
  <A, E>(f: Effect.Effect<A, E, Memory | GraphMemory | Config>) =>
    Effect.runPromise(f.pipe(Effect.provide(graphOnStore(root).pipe(Layer.provide(diskStore(home)))), Effect.provideService(Config, config), Effect.scoped))
const live = Effect.flatMap(GraphMemory, (gm) => gm.use((g) => query(g, { kind: "note", limit: 100 }).map((s) => show(g, s.id)!)))

// memory.use picks the plugin: notes leaves GraphMemory out (the notes plugin behaves as before), graph provides it with the pull.
test("memory.use = notes has no GraphMemory; memory.use = graph provides it and the turn-start pull", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-plugins-"))
  const run = (config: object) => {
    writeFileSync(join(dir, "config.json"), JSON.stringify(config))
    const script = `import { Context, Effect, Layer, Option } from "effect"; import { Config } from "./src/base/config"; import { MemoryPull } from "./src/base/memory"; import { GraphMemory } from "./src/base/graph-memory"; import { StoreAndMemoryFromConfig } from "./src/plugins/index"
      Effect.runPromise(Effect.gen(function* () { const services = yield* Layer.build(StoreAndMemoryFromConfig); return [Option.isSome(Context.getOption(services, GraphMemory)), typeof Context.get(services, MemoryPull).candidates].join(" ") }).pipe(Effect.scoped, Effect.provide(Config.layer))).then(console.log)`
    const r = Bun.spawnSync(["bun", "-e", script], { cwd: join(import.meta.dir, "../.."), env: { ...process.env, EMPTY_VESSEL_HOME: dir, EMPTY_VESSEL_SYSTEM_TWO: "", EMPTY_VESSEL_MEMORY: "" }, stdout: "pipe", stderr: "pipe" })
    return (r.stdout.toString() + r.stderr.toString()).trim()
  }

  expect(run({ systemTwo: { use: "fake" } })).toBe("false undefined")
  expect(run({ systemTwo: { use: "fake" }, memory: { use: "graph" } })).toBe("true function")
})

// Facts reach a turn only through the pull (KTD12): the briefing, cached once per conversation, carries none.
test("with the graph the briefing has no fact text; with the notes it still has the notes", async () => {
  const { home, root } = dirs()
  await withGraph(home, root)(Effect.flatMap(Memory, (m) => m.add("project", "tests run with bun test")))

  const graphBriefing = await withGraph(home, root)(briefing(root))
  const notes = await Effect.runPromise(Effect.gen(function* () {
    yield* (yield* Memory).add("project", "tests run with bun test")
    return yield* briefing(root)
  }).pipe(Effect.provide(memoryOnStore(root).pipe(Layer.provide(diskStore(mkdtempSync(join(tmpdir(), "empty-vessel-home-"))))))))

  expect(graphBriefing).not.toContain("tests run with bun test")
  expect(notes).toContain("tests run with bun test")
})

test("/memory lists facts with ids; remove <id> retires one; add <text> writes a user fact backed by a checked observation", async () => {
  const { home, root } = dirs()
  const run = withGraph(home, root)
  await run(Effect.flatMap(Memory, (m) => Effect.all([m.add("project", "tests run with bun test"), m.add("agent", "rg isn't installed")])))

  const facts = await run(live)
  const id = facts.find((f) => f.text === "rg isn't installed")!.id
  const list = await run(memoryCommand(""))
  expect(list).toContain(`${id.slice(0, 8)} rg isn't installed`)
  expect(list).toContain("tests run with bun test")

  expect(await run(memoryCommand(`remove ${id.slice(0, 8)}`))).toBe("forgot: rg isn't installed")
  expect(await run(memoryCommand(""))).not.toContain("rg isn't installed")
  expect(await run(memoryCommand("remove nope"))).toContain("no fact")

  expect(await run(memoryCommand("add answers in plain words"))).toBe("remembered (user): answers in plain words")
  const added = (await run(live)).find((f) => f.text === "answers in plain words")!
  expect(added).toMatchObject({ attrs: { scope: "user" }, status: "verified" })
  const evidence = await run(Effect.flatMap(GraphMemory, (gm) => gm.use((g) => why(g, added.id)!.evidence.map((e) => show(g, e.fact.id)!))))
  expect(evidence).toMatchObject([{ source: "user", source_trust: "checked" }])
})

// /memory edit opens the export; on save a removed line retires its fact and an added line becomes a fact the user stated.
test("/memory edit: a removed line retires its fact; an added line becomes a fact backed by a checked observation", async () => {
  const { home, root } = dirs()
  const run = withGraph(home, root)
  await run(Effect.flatMap(Memory, (m) => Effect.all([m.add("user", "prefers short answers"), m.add("user", "lives in Porto")])))

  // The "editor": drops "lives in Porto" and adds a line under the profile's heading.
  const editor = join(mkdtempSync(join(tmpdir(), "empty-vessel-editor-")), "edit.ts")
  writeFileSync(editor, `const f = process.argv[2]!; const t = await Bun.file(f).text(); await Bun.write(f, t.replace("- lives in Porto\\n", "").replace("- prefers short answers\\n", "- prefers short answers\\n- moved to Lisbon\\n"))`)
  const before = process.env.EDITOR
  process.env.EDITOR = `bun ${editor}`
  const said = await run(memoryCommand("edit", true)).finally(() => { process.env.EDITOR = before })

  const facts = await run(live)
  expect(said).toBe("1 forgotten, 1 remembered")
  expect(facts.map((f) => f.text).sort()).toEqual(["moved to Lisbon", "prefers short answers"])
  expect(facts.find((f) => f.text === "moved to Lisbon")).toMatchObject({ attrs: { scope: "user" }, status: "verified" })
  expect(await run(memoryCommand("edit"))).toContain("$EDITOR") // inside the TUI there's no editor to open
})
