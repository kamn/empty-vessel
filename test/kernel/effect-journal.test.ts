import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Context, Effect } from "effect"
import { CurrentSession, SessionError, type SessionHandle } from "../../src/base/session"
import { makeKernel, type HostFunctions, type ToolSource } from "../../src/kernel/kernel"
import { remoteSource } from "../../src/kernel/mcp"
import { ActionGuard } from "../../src/tools/action-guard"
import { makeHost } from "../../src/loop/kernel"
import { EFFECTS, effectful, makeGuardedKernel } from "../../src/tools/kernel-service"

// The effect journal: before an effectful built-in runs, the session records it (an `effect` entry, synced).
const BUILTINS = resolve("src/tools/kernel-builtins.ts")
type Entry = { role: string; text: string; extra: Record<string, unknown>; sync: boolean }

const setup = (options: { sources?: ReadonlyArray<ToolSource>; failRecord?: boolean; deny?: boolean } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-journal-"))
  const kernel = makeGuardedKernel({ dir, builtins: BUILTINS, spareWorker: false, timeoutMs: 20_000, ...(options.sources ? { sources: options.sources } : {}) })
  const entries: Array<Entry> = []
  const session = {
    id: "s", key: "sessions/s", dir,
    record: (role: string, text: string, extra: Record<string, unknown> = {}, o?: { sync?: boolean }) =>
      options.failRecord ? Effect.fail(new SessionError({ cause: "disk full" })) : Effect.sync(() => { entries.push({ role, text, extra, sync: o?.sync === true }) }),
  } as unknown as SessionHandle
  const run = (code: string, host: HostFunctions = {}) => Effect.runPromise(kernel.run(code, host).pipe(
    Effect.provideService(CurrentSession, session),
    Effect.provideService(ActionGuard, { beforeAction: () => Effect.succeed(options.deny ? { decision: "deny" as const, reason: "no" } : { decision: "allow" as const }) }),
  ))
  const effects = () => entries.filter((e) => e.role === "effect")
  return { dir, run, effects }
}

test("write then read: one intent and one outcome for write, nothing for read", async () => {
  const { dir, run, effects } = setup()
  const file = join(dir, "a.txt")
  const r = await run(`import { Effect, read, write } from "kernel"
export default Effect.gen(function* () { yield* write(${JSON.stringify(file)}, "hi"); return yield* read(${JSON.stringify(file)}) })`)

  expect(r.status).toBe("ok")
  expect(readFileSync(file, "utf8")).toBe("hi")
  const [intent, outcome, ...rest] = effects()
  expect(rest).toEqual([])
  expect(intent).toMatchObject({ text: `write ${file}`, extra: { cell: 1, kernel: dir }, sync: true })
  expect(intent!.extra.outcome).toBeUndefined()
  expect(outcome).toMatchObject({ text: `write ${file}`, extra: { cell: 1, kernel: dir, id: intent!.extra.id } })
  expect(String(outcome!.extra.outcome)).toContain(file)
}, 60_000)

test("edit records an intent and outcome; the cell number is the cell's own", async () => {
  const { dir, run, effects } = setup()
  const file = join(dir, "b.txt")
  await run(`import { write } from "kernel"\nexport default write(${JSON.stringify(file)}, "one")`)
  await run(`import { edit } from "kernel"\nexport default edit(${JSON.stringify(file)}, [{ oldText: "one", newText: "two" }])`)

  expect(readFileSync(file, "utf8")).toBe("two")
  expect(effects().filter((e) => e.extra.cell === 2).map((e) => e.text)).toEqual([`edit ${file}`, `edit ${file}`])
}, 60_000)

test("bash records an intent before the command runs; a denied command records nothing", async () => {
  const { run, effects } = setup()
  const r = await run(`import { bash } from "kernel"\nexport default bash("ls", 5)`)

  expect(r.status).toBe("ok")
  expect(effects()).toMatchObject([{ text: "bash ls", extra: { cell: 1 }, sync: true }])

  const denied = setup({ deny: true })
  expect(String((await denied.run(`import { bash } from "kernel"\nexport default bash("ls", 5)`)).value)).toContain("ActionGuard deny")
  expect(denied.effects()).toEqual([])
}, 60_000)

test("host built-ins: spawn records an intent, tools and systemOne record nothing", async () => {
  const { run, effects } = setup()
  const host: HostFunctions = { spawn: () => Effect.succeed("job-1"), tools: () => Effect.succeed({}), systemOne: () => Effect.succeed({}) }
  const r = await run(`import { Effect, spawn, tools, systemOne } from "kernel"
export default Effect.all([tools(), systemOne("x", {}), spawn("fix the tests")])`, host)

  expect(r.status).toBe("ok")
  expect(effects()).toMatchObject([{ text: `spawn "fix the tests"`, extra: { cell: 1 }, sync: true }])
}, 60_000)

test("an MCP tool marked readOnlyHint records nothing; one without it records an intent", async () => {
  const tools = [
    { name: "look", description: "Look", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    { name: "change", description: "Change", inputSchema: { type: "object" } },
  ]
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const m = await req.json() as any
      if (m.id === undefined) return new Response(null, { status: 202 })
      const result = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } }
        : m.method === "tools/list" ? { tools }
        : { content: [{ type: "text", text: `did ${m.params.name}` }] }
      return Response.json({ jsonrpc: "2.0", id: m.id, result })
    },
  })

  try {
    const source = remoteSource({ name: "svc", url: `http://localhost:${server.port}/mcp` })
    expect((await source.tools()).map((t) => t.readOnlyHint)).toEqual([true, undefined])

    const { run, effects } = setup({ sources: [source] })
    const r = await run(`import { Effect, svc } from "kernel"\nexport default Effect.all([svc.look({}), svc.change({ to: 1 })])`)
    expect(r).toMatchObject({ status: "ok", value: ["did look", "did change"] })
    expect(effects()).toMatchObject([{ text: `svc.change {"to":1}`, extra: { cell: 1 }, sync: true }])
  } finally { server.stop(true) }
}, 60_000)

test("a cell can't write without the journal: a failed record stops the write, a supplied $effect doesn't replace it", async () => {
  const failing = setup({ failRecord: true })
  const file = join(failing.dir, "c.txt")
  const r = await failing.run(`import { write } from "kernel"\nexport default write(${JSON.stringify(file)}, "x")`)
  expect(String(r.value)).toContain("not done")
  expect(existsSync(file)).toBe(false)

  const forged = setup()
  const other = join(forged.dir, "d.txt")
  await forged.run(`import { write } from "kernel"\nexport default write(${JSON.stringify(other)}, "x")`, { $effect: () => Effect.succeed("forged") })
  expect(forged.effects().map((e) => e.text)).toEqual([`write ${other}`, `write ${other}`])
}, 60_000)

test("a kernel without the journal ($effect) refuses write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-journal-"))
  const file = join(dir, "e.txt")
  const r = await Effect.runPromise(makeKernel({ dir, builtins: BUILTINS, spareWorker: false }).run(`import { write } from "kernel"\nexport default write(${JSON.stringify(file)}, "x")`))

  expect(String(r.value)).toContain("not done")
  expect(existsSync(file)).toBe(false)
}, 60_000)

test("every exported built-in and host function is classified; unknown names are effectful", () => {
  const exported = new Bun.Transpiler({ loader: "ts" }).scan(readFileSync(BUILTINS, "utf8")).exports
  const host = Object.keys(makeHost({} as never, Context.empty() as never))

  expect([...exported, ...host, "$source", "$actionGuard", "$effect"].filter((n) => !(n in EFFECTS))).toEqual([])
  expect(effectful("somethingNew")).toBe(true)
  expect(effectful("read")).toBe(false)
  expect(effectful("write")).toBe(true)
})
