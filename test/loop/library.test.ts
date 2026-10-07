import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { makeKernel } from "../../src/kernel/kernel"
import { Fill } from "../../src/system-two/fill"
import { BUILTINS, builtinsModule, kernelImports, loadLibrary, loadPool, newDependencies, pickCell, promote, saveLibrary, shortlist, TSC, updateTools, writeBuiltins } from "../../src/loop/library"
import { libraryStep, saysNothing } from "../../src/loop/steps"
import { ALL } from "../../src/base/grants"
import { confirmPick } from "../../src/loop/turn"

// System Two's kernel with a few cells, and an empty library.
const setup = async (cells: ReadonlyArray<string>) => {
  const kernelDir = mkdtempSync(join(tmpdir(), "empty-vessel-two-"))
  const two = makeKernel({ dir: kernelDir, builtins: BUILTINS, tsc: TSC })
  for (const c of cells) await Effect.runPromise(two.run(c))
  return { kernelDir, library: join(mkdtempSync(join(tmpdir(), "empty-vessel-lib-")), "library") }
}
const tryPromote = (s: { kernelDir: string; library: string }, name: string, example = "hello") =>
  Effect.runPromise(promote(s.library, s.kernelDir, "session-1", {}, { name, description: "The goal asks to shout something", example }))

test("a self-contained definition is promoted, and a kernel with the library's built-ins runs it on a goal", async () => {
  const s = await setup([`import { Effect } from "kernel"\nexport const shout = (goal: string) => Effect.succeed(goal.toUpperCase() + "!")`])
  expect(await tryPromote(s, "shout")).toContain("promoted shout")
  expect(loadLibrary(s.library)).toMatchObject([{ name: "shout", description: "The goal asks to shout something", from: "session-1" }])

  const oneDir = mkdtempSync(join(tmpdir(), "empty-vessel-one-"))
  const one = makeKernel({ dir: oneDir, builtins: writeBuiltins(join(oneDir, "builtins.ts"), s.library) })
  expect((await Effect.runPromise(one.run(pickCell("shout", "hi there")))).value).toBe("HI THERE!")
})

test("a definition that uses earlier cells' definitions is refused, with what it needs", async () => {
  const s = await setup([`export const excited = (s: string) => s + "!"`, `import { excited } from "kernel"\nexport const shout = (goal: string) => excited(goal.toUpperCase())`])
  expect(await tryPromote(s, "shout")).toContain("uses excited from earlier cells")
  expect(loadLibrary(s.library)).toEqual([])
})

test("a definition that doesn't take the goal, or fails on the example, isn't promoted", async () => {
  const s = await setup([`export const double = (n: number) => n * 2`, `export const broken = (goal: string) => { throw new Error("nope: " + goal) }`])
  expect(await tryPromote(s, "double")).toContain("type-error")
  expect(await tryPromote(s, "broken")).toContain("nope: hello")
  expect(await tryPromote(s, "escalate")).toContain("can't be promoted under that name")
  expect(await tryPromote(s, "missing")).toContain("no definition named missing")
  expect(loadLibrary(s.library)).toEqual([])
})

test("System One's library step runs a promoted definition on the goal in its own kernel; its value is the answer", async () => {
  const s = await setup([`import { Effect } from "kernel"\nexport const shout = (goal: string) => Effect.succeed(goal.toUpperCase() + "!")`])
  await tryPromote(s, "shout")

  const session = { dir: mkdtempSync(join(tmpdir(), "empty-vessel-session-")) }
  const state = { did: [] as Array<string>, offered: { systemOne: [], systemTwo: [] } }
  const ctx = { session, input: "ship it", depth: 0, config: { kernel: { tools: ALL } } }
  const r = await Effect.runPromise(libraryStep("shout", s.library)(ctx as never, state as never) as Effect.Effect<unknown>)
  expect(r).toEqual({ reply: "SHIP IT!", outcome: "ok", answer: true })
  expect(state.did).toEqual(["shout"])
})

// A stand-in for the small model: finds a plugin name in the request, however it's worded, or says it isn't there.
const fakeFill = Layer.succeed(Fill, { fill: (_name, _schema, goal) => Effect.succeed({ args: { plugin: goal.match(/\b(relativeTime|utc)\b/)?.[1] ?? null } as never, tokens: { input: 1, output: 1 } }) })

test("a tool with a parameter is promoted with it; System One's step fills it from differently worded requests, and doesn't run it when the request doesn't say", async () => {
  const s = await setup([`import { Effect } from "kernel"\nexport const testFileFor = ({ plugin }: { plugin: string }) => Effect.succeed("test/plugin/" + plugin + ".test.js")`])
  const host = { fill: (arg: unknown) => { const { request } = arg as { request: string }; const plugin = request.match(/\b(relativeTime|utc)\b/)?.[1]; return Effect.succeed({ args: { plugin: plugin ?? "" }, missing: plugin ? [] : ["plugin"] }) } }
  const promoted = await Effect.runPromise(promote(s.library, s.kernelDir, "session-1", host, { name: "testFileFor", description: "The test file that covers a plugin", example: "Which test covers the utc plugin?", parameters: { plugin: "the plugin's name" } }))
  expect(promoted).toContain("promoted testFileFor")
  expect(loadLibrary(s.library)).toMatchObject([{ name: "testFileFor", parameters: { plugin: "the plugin's name" } }])

  const pick = (input: string) => {
    const state = { did: [] as Array<string>, offered: { systemOne: [], systemTwo: [] } }
    const ctx = { session: { dir: mkdtempSync(join(tmpdir(), "empty-vessel-session-")) }, input, depth: 0, usage: { add: () => Effect.void }, config: { kernel: { tools: ALL } } }
    return Effect.runPromise((libraryStep("testFileFor", s.library)(ctx as never, state as never) as Effect.Effect<unknown, unknown, Fill>).pipe(Effect.provide(fakeFill)))
  }
  const answer = { reply: "test/plugin/relativeTime.test.js", outcome: "ok", answer: true }
  expect(await pick("Which test file covers the relativeTime plugin?")).toEqual(answer)
  expect(await pick("relativeTime: where are its tests?")).toEqual(answer)
  expect(await pick("Which test covers this plugin?")).toEqual({ reply: "testFileFor wasn't run: the request doesn't say its plugin", outcome: "failed" })
})

test("a tool whose parameters can't be filled from its own example isn't promoted", async () => {
  const s = await setup([`import { Effect } from "kernel"\nexport const testFileFor = ({ plugin }: { plugin: string }) => Effect.succeed(plugin)`])
  const host = { fill: () => Effect.succeed({ args: { plugin: "" }, missing: ["plugin"] }) }
  expect(await Effect.runPromise(promote(s.library, s.kernelDir, "session-1", host, { name: "testFileFor", description: "The test file that covers a plugin", example: "Which test covers this?", parameters: { plugin: "the plugin's name" } }))).toContain("couldn't be filled from the example")
  expect(loadLibrary(s.library)).toEqual([])
})

test("a doubtful library pick is confirmed by one yes/no question; a no, or an unsure yes, isn't a fit", async () => {
  const ctxAnswering = (choice: string, confidence: number) => ({
    input: "How many todos are still open?",
    usage: { add: () => Effect.void },
    systemOne: { decide: () => Effect.succeed({ answers: { fits: { choice, confidence } }, tokens: { input: 0, output: 0 } }) },
  }) as never
  const fits = (choice: string, confidence: number) => Effect.runPromise(confirmPick(ctxAnswering(choice, confidence), "The request asks how many todos are open"))

  expect(await fits("yes", 0.8)).toEqual({ fits: true, confidence: 0.8 })
  expect((await fits("no", 0.9)).fits).toBe(false)
  expect((await fits("yes", 0.4)).fits).toBe(false) // the doubt rule: below 0.5 on a yes/no is "unsure"
  expect((await fits("unclear", 0.9)).fits).toBe(false)
})

test("the shortlist: all tools if there are few; else the best 5 at 0.5 or more, plus tools System Two handed over", async () => {
  const entries = Array.from({ length: 8 }, (_, i) => ({ name: `tool${i}`, description: `does ${i}`, file: "", from: "" }))
  const scores = { tool0: 0.9, tool1: 0.2, tool2: 0.7, tool3: 0.55, tool4: 0.95, tool5: 0.6, tool6: 0.52, tool7: 0.1 }
  const one = { judge: () => Effect.succeed({ answers: scores, tokens: { input: 0, output: 0 } }) } as never
  const names = async (list: typeof entries, loaded: Set<string>) => (await Effect.runPromise(shortlist(one, "goal", list, loaded))).shown.map((e) => e.name)

  expect(await names(entries.slice(0, 5), new Set())).toEqual(["tool0", "tool1", "tool2", "tool3", "tool4"]) // 5 or fewer: no call, all shown
  expect(await names(entries, new Set())).toEqual(["tool4", "tool0", "tool2", "tool5", "tool3"])
  expect(await names(entries, new Set(["tool7"]))).toEqual(["tool4", "tool0", "tool2", "tool5", "tool3", "tool7"])
})

test("System Two's kernel can import library tools; a definition that uses one isn't promoted (not yet)", async () => {
  const s = await setup([`import { Effect } from "kernel"\nexport const shout = (goal: string) => Effect.succeed(goal.toUpperCase() + "!")`])
  await tryPromote(s, "shout")

  const kernelDir = mkdtempSync(join(tmpdir(), "empty-vessel-two-"))
  const two = makeKernel({ dir: kernelDir, builtins: writeBuiltins(join(kernelDir, "builtins.ts"), s.library), tsc: TSC })
  await Effect.runPromise(two.run(`import { Effect, shout } from "kernel"\nexport const louder = (goal: string) => shout(goal + " now")`))
  expect((await Effect.runPromise(two.run(`import { louder } from "kernel"\nexport default louder("go")`))).value).toBe("GO NOW!")

  expect(await Effect.runPromise(promote(s.library, kernelDir, "session-2", {}, { name: "louder", description: "Shout louder", example: "go" }))).toContain("library tools can't use each other yet")
})

test("System One grades a new tool's description: a confident no on any criterion sends it back; an unsure no doesn't", async () => {
  const s = await setup([`import { Effect } from "kernel"\nexport const shout = (goal: string) => Effect.succeed(goal.toUpperCase() + "!")`])
  let asked: unknown
  const systemOneSaying = (answers: Record<string, { choice: string; confidence: number }>) => ({ systemOne: (arg: unknown) => { asked = arg; return Effect.succeed(answers) } })
  const yes = { choice: "yes", confidence: 0.9 }
  const tryWith = (host: object) => Effect.runPromise(promote(s.library, s.kernelDir, "session-1", host as never, { name: "shout", description: "Shouts the request back", example: "hi" }))

  const refused = await tryWith(systemOneSaying({ specific: yes, matches: yes, notFor: { choice: "no", confidence: 0.8 }, distinct: yes }))
  expect(refused).toContain("falls short on")
  expect(refused).toContain("which close requests it doesn't answer")
  expect(JSON.stringify(asked)).toContain("goal.toUpperCase()") // System One sees the code, to judge "matches"
  expect(loadLibrary(s.library)).toEqual([])

  expect(await tryWith(systemOneSaying({ specific: yes, matches: yes, notFor: { choice: "no", confidence: 0.4 }, distinct: yes }))).toContain("promoted shout")
})

test("a System Two helper (any arguments) goes into the pool on its example call; the System One path refuses it", async () => {
  const s = await setup([`export const repeatText = (text: string, times: number) => text.repeat(times)`])
  const tryAs = (forWho: "systemOne" | "systemTwo", example: string) =>
    Effect.runPromise(promote(s.library, s.kernelDir, "session-1", {}, { name: "repeatText", description: "Repeats text: repeatText(text, times) returns it times times", example, for: forWho }, "pool"))

  expect(await tryAs("systemOne", "hello")).toContain("type-error")
  expect(await tryAs("systemTwo", `repeatText("ab", 3)`)).toContain("added repeatText to the pool")
  expect(loadPool(s.library)).toMatchObject([{ name: "repeatText", for: "systemTwo" }])
  expect(loadLibrary(s.library)).toEqual([]) // on trial, not in the library
})

test("the imports System Two's cells make from kernel are what counts as using a trial tool", () => {
  expect(kernelImports(`import { Effect, grepSource as g } from "kernel"\nimport { x } from "./other"`)).toEqual(["Effect", "grepSource"])
})

test("no new dependencies (for now): tools that install packages or need one the project doesn't have are refused", () => {
  const root = process.cwd() // this repo: effect is installed, left-pad-xyz isn't
  expect(newDependencies(`import { Effect } from "effect"\nimport { readFileSync } from "node:fs"\nimport { bash } from "./scope-3.ts"`, root)).toBeUndefined()
  expect(newDependencies(`execFileSync('npm', ['install', '--prefix', tmp, 'typescript'])`, root)).toContain("installs packages")
  expect(newDependencies(`bash("npx tsc --noEmit")`, root)).toBeUndefined() // tsc is installed here: npx runs it, installs nothing
  expect(newDependencies(`bash("bunx cowsay-xyz hi")`, root)).toBe("it installs packages (bunx cowsay-xyz: cowsay-xyz isn't installed in this project)")
  expect(newDependencies(`bash("npx -y tsc")`, root)).toContain("installs packages")
  expect(newDependencies("bash(`npx ${tool}`)", root)).toContain("can't tell what it runs")
  expect(newDependencies(`const pad = require("left-pad-xyz")`, root)).toBe("it needs packages this project doesn't have (left-pad-xyz)")
})

test("a pool promote can't take a library tool's name: refused, and the library tool's code isn't touched", async () => {
  const s = await setup([`export const shout = (goal: string) => goal.toUpperCase() + "!"`, `export const shout = (goal: string) => "changed"`])
  saveLibrary(s.library, [{ name: "shout", description: "Shouts the request", file: join(s.library, "shout.ts"), from: "earlier", for: "systemOne" }])
  writeFileSync(join(s.library, "shout.ts"), `export const shout = (goal: string) => goal.toUpperCase() + "!"\n`)

  expect(await Effect.runPromise(promote(s.library, s.kernelDir, "session-2", {}, { name: "shout", description: "Changed", example: "hi" }, "pool"))).toContain("already a library tool")
  expect(loadPool(s.library)).toEqual([])
  expect(readFileSync(join(s.library, "shout.ts"), "utf8")).toContain("toUpperCase")
})

test("a name in both the library and the pool is exported once, so kernels still load", () => {
  const module = builtinsModule([{ name: "shout", file: "/a/shout.ts" }, { name: "shout", file: "/b/shout.ts" }, { name: "read", file: "/c/read.ts" }])
  expect(module.match(/export \{ shout \}/g)).toHaveLength(1)
  expect(module).toContain(`export { shout } from "/a/shout.ts"`) // the first (the library's)
  expect(module).not.toContain("/c/read.ts") // never shadows a built-in
})

test("updates under the lock don't lose each other: 6 processes adding 5 tools each, all 30 land", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "empty-vessel-lock-")), "library")
  const lib = new URL("../../src/loop/library.ts", import.meta.url).pathname
  const script = (p: number) => `import { Effect } from "effect"; import { updateTools } from ${JSON.stringify(lib)}
for (let i = 0; i < 5; i++) await Effect.runPromise(updateTools(${JSON.stringify(dir)}, (_l, pool) => { const t = Date.now(); while (Date.now() - t < 5) {} return { pool: [...pool, { name: "p${p}t" + i, description: "", file: "", from: "", for: "systemOne" }], result: 0 } }))`
  const procs = Array.from({ length: 6 }, (_, p) => Bun.spawn(["bun", "-e", script(p)], { cwd: new URL("../..", import.meta.url).pathname, stderr: "inherit" }))
  await Promise.all(procs.map((p) => p.exited))
  expect(loadPool(dir)).toHaveLength(30)
}, 30_000)

test("promote cleans up its scratch folder, whether the tool is accepted or refused", async () => {
  const scratch = () => readdirSync(tmpdir()).filter((d) => d.startsWith("empty-vessel-promote-")).length
  const s = await setup([`export const shout = (goal: string) => goal.toUpperCase()`, `export const broken = (goal: string) => { throw new Error("no") }`])
  const before = scratch()
  expect(await tryPromote(s, "shout")).toContain("promoted")
  expect(await tryPromote(s, "broken")).toContain("not promoted")
  expect(scratch()).toBe(before)
})

test("a tool made before the kernel's rules (raw file reads) is left out wherever tools load; one that follows them stays", () => {
  const library = mkdtempSync(join(tmpdir(), "empty-vessel-lib-"))
  writeFileSync(join(library, "scope.ts"), "")
  writeFileSync(join(library, "old.ts"), `import { readFileSync } from "node:fs"\nexport const old = (goal: string) => String(JSON.parse(readFileSync("package.json", "utf8")).version)`)
  writeFileSync(join(library, "fresh.ts"), `import { Effect, readText } from "./scope.ts"\nexport const fresh = (goal: string) => readText("package.json").pipe(Effect.map((t) => String(JSON.parse(t).version)))`)
  const entry = (name: string) => ({ name, description: "the version", file: join(library, `${name}.ts`), from: "s", for: "systemOne" as const })
  writeFileSync(join(library, "pool.json"), JSON.stringify([entry("old"), entry("fresh")]))

  expect(loadPool(library).map((e) => e.name)).toEqual(["fresh"])
  expect(builtinsModule(loadPool(library))).not.toContain("old.ts")
})

test("pool and library entries saved before System One's generic name (for: \"jev\") load as systemOne", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-lib-"))
  const old = { name: "shout", description: "Shouts", file: join(dir, "missing.ts"), from: "s", for: "jev" }
  writeFileSync(join(dir, "pool.json"), JSON.stringify([old]))
  writeFileSync(join(dir, "library.json"), JSON.stringify([old]))
  expect(loadPool(dir)).toMatchObject([{ name: "shout", for: "systemOne" }])
  expect(loadLibrary(dir)).toMatchObject([{ name: "shout", for: "systemOne" }])
})

test("a tool's value that answers nothing isn't an answer: empty, or a command's bare exit code", () => {
  for (const v of ["", "  ", "exit 0", "exit 0 (no output)", "exit 0\n(no output)", "exit 1", null, [], {}]) expect(saysNothing(v)).toBe(true)
  for (const v of ["src/locale/ja.js", "exit 0\nsrc/locale/ja.js", "0", ["a"], { file: "x" }]) expect(saysNothing(v)).toBe(false)
})
