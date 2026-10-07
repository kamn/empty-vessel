import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { ALL, type Grants } from "../../src/base/grants"
import { builtinsModule, TSC } from "../../src/loop/library"
import type { KernelService } from "../../src/tools/kernel-service"

// The rules every kernel follows: what a cell can count on, whatever runs it. A kernel
// passes them by running kernelRules with its own `open`: the Bun Worker does (test/kernel/kernel.test.ts), and a new
// kernel (Deno, a container) is done when it does too. How a kernel protects the machine (no process, a safe
// environment, the guard) is its own business, tested beside it, not here.
export const kernelRules = (name: string, open: KernelService["open"]) => {
  const fresh = (extra: Record<string, unknown> = {}) => open({ dir: mkdtempSync(`${tmpdir()}/empty-vessel-kernel-`), timeoutMs: 5000, ...extra })
  const run = (k: ReturnType<KernelService["open"]>, code: string, host = {}) => Effect.runPromise(k.run(code, host))

  // A kernel granting `g`, its built-ins module written as empty-vessel writes it (src/loop/library.ts builtinsModule).
  const granting = (g: Grants) => {
    const dir = mkdtempSync(join(tmpdir(), "empty-vessel-grants-"))
    writeFileSync(join(dir, "builtins.ts"), builtinsModule([], g))
    return { dir, k: open({ dir: join(dir, "kernel"), builtins: join(dir, "builtins.ts"), tsc: TSC }) }
  }
  const runGranting = (g: Grants, code: string) => { const { dir, k } = granting(g); return Effect.runPromise(k.run(code.replaceAll("DIR", dir))).then((r) => ({ ...r, dir })) }

  test(`${name}: loading a cell only defines things, so every later cell imports every earlier one, and none of them runs again`, async () => {
    let calls = 0
    const host = { count: () => Effect.sync(() => ++calls) }
    const k = fresh()
    await run(k, `import { Effect, call } from "kernel"\nexport const counted = call("count")\nexport const shout = (s: string) => s.toUpperCase()`, host)
    await run(k, `export const n = 2`)

    expect(await run(k, `import { Effect, n } from "kernel"\nexport default Effect.succeed(n + 1)`, host)).toMatchObject({ status: "ok", value: 3 })
    expect(await run(k, `import { shout } from "kernel"\nexport default () => shout("hi")`, host)).toMatchObject({ status: "ok", value: "HI" })
    expect(calls).toBe(0) // `counted` is an Effect: defined, never run by loading
    expect(await run(k, `import { counted } from "kernel"\nexport default counted`, host)).toMatchObject({ status: "ok", value: 1 })
  })

  test(`${name}: a top level that does work is refused before it runs (the rules), or fails when it loads (a host call there)`, async () => {
    const k = fresh()
    const refused = await run(k, `import { readFileSync } from "node:fs"\nexport const data = await Bun.file("x").text()\nlet count = 0`)
    expect(refused.status).toBe("refused")
    expect(refused.summary).toContain(`imports from node:fs`)
    expect(refused.summary).toContain("Bun isn't available in a cell")
    expect(refused.summary).toContain("await at the top level")
    expect(refused.summary).toContain("let at the top level")

    const host = { count: () => Effect.succeed(1) }
    const worked = await run(k, `import { Effect, call } from "kernel"\nconst go = (e: Effect.Effect<unknown, Error>) => Effect.runFork(e)\nexport const x = 1`, host)
    expect(worked.status).toBe("refused") // Effect.runFork: running an Effect by hand
  })

  test(`${name}: definitions carry to later cells; the action runs once and its result is stored as $N`, async () => {
    const k = fresh()
    const one = await run(k, `import { Effect } from "kernel"\nexport const double = (n: number) => Effect.succeed(n * 2)`)
    expect(one).toMatchObject({ n: 1, status: "ok", defines: ["double"] })

    const two = await run(k, `import { Effect, double } from "kernel"\nexport default Effect.gen(function* () { return [yield* double(21), yield* double(4)] })`)
    expect(two).toMatchObject({ n: 2, status: "ok", value: [42, 8] })
    expect(two.summary).toContain("$2 (2 items)")

    const three = await run(k, `import { result } from "kernel"\nexport default () => result(2)`)
    expect(three.value).toEqual([42, 8]) // an earlier result, read back
  })

  test(`${name}: a later definition with the same name wins; a failed cell's definitions are not kept`, async () => {
    const k = fresh()
    await run(k, `export const greet = () => "v1"`)
    await run(k, `export const greet = () => "v2"`)
    await run(k, `export const greet = () => "v3"\nthrow new Error("broken")`)
    expect((await run(k, `import { greet } from "kernel"\nexport default greet`)).value).toBe("v2")
  })

  for (const failure of ["error", "timeout"] as const) {
    test(`${name}: an action's ${failure} keeps previous definitions and results intact; later cells recover`, async () => {
      const dir = mkdtempSync(`${tmpdir()}/empty-vessel-failed-action-`)
      const k = open({ dir, timeoutMs: 1500 })
      let started = 0
      const host = { started: () => Effect.sync(() => ++started) }
      const first = await run(k, `export const greet = () => "v1"\nexport default "saved before failure"`)
      expect(first).toMatchObject({ status: "ok", value: "saved before failure" })

      const failed = await run(k, `import { Effect, call } from "kernel"
export const greet = () => "v2"
export const failedOnly = "must not escape"
export default Effect.gen(function* () {
  yield* call("started")
  ${failure === "error" ? 'throw new Error("action failed after starting")' : "return yield* Effect.never"}
})`, host)

      // Prove this is action failure, not refusal or failure while importing the cell.
      expect(started).toBe(1)
      expect(failed).toMatchObject({ n: first.n + 1, status: failure, defines: [] })
      if (failure === "error") expect(failed.error).toContain("action failed after starting")
      expect(existsSync(join(dir, "results", `${failed.n}.json`))).toBe(false)
      expect(k.cells().find((cell) => cell.n === failed.n)).toMatchObject({ status: failure, defines: [] })

      const after = await run(k, `import * as scope from "kernel"
export default () => ({ greeting: scope.greet(), leaked: "failedOnly" in scope, earlier: scope.result(${first.n}) })`)
      expect(after).toMatchObject({ status: "ok", value: { greeting: "v1", leaked: false, earlier: "saved before failure" } })

      const recovered = await run(k, `export const greet = () => "v3"
export const recoveredOnly = "available"
export default { recovered: true }`)
      expect(recovered).toMatchObject({ status: "ok", defines: expect.arrayContaining(["greet", "recoveredOnly"]), value: { recovered: true } })
      expect(JSON.parse(readFileSync(join(dir, "results", `${recovered.n}.json`), "utf8"))).toEqual({ recovered: true })

      const last = await run(k, `import { greet, recoveredOnly, result } from "kernel"
export default () => ({ greeting: greet(), recoveredOnly, saved: result(${recovered.n}) })`)
      expect(last).toMatchObject({ status: "ok", value: { greeting: "v3", recoveredOnly: "available", saved: { recovered: true } } })
    }, 15_000)
  }

  test(`${name}: cells reach the host through call; console output comes back as logs, not onto the terminal`, async () => {
    const k = fresh()
    const host = { double: (n: unknown) => Effect.succeed((n as number) * 2) }
    const r = await run(k, `import { Effect, call } from "kernel"\nexport default Effect.gen(function* () { console.log("thinking"); return yield* call("double", yield* call("double", 21)) })`, host)
    expect(r).toMatchObject({ status: "ok", value: 84, logs: "thinking" })
    const missing = await run(k, `import { call } from "kernel"\nexport default call("nope")`, host)
    expect(missing.status).toBe("error")
    expect(missing.error).toContain(`no host function "nope"`)
  })

  test(`${name}: with a type checker, a type error comes back before the cell runs`, async () => {
    const dir = mkdtempSync(`${tmpdir()}/empty-vessel-kernel-`)
    const k = open({ dir, tsc: `${import.meta.dir}/../../node_modules/.bin/tsc` })
    const r = await run(k, `import { Effect } from "kernel"\nexport default Effect.gen(function* () { const n: number = "text"; writeFile(); return n })\ndeclare function writeFile(): void`)
    expect(r.status).toBe("type-error")
    expect(r.summary).toContain("not assignable to type 'number'")
    expect((await run(k, `import { Effect } from "kernel"\nexport default Effect.succeed(1 + 1)`)).value).toBe(2)
  }, 60_000) // a type check: a fresh tsc (plain) can take seconds while the whole suite runs

  test(`${name}: built-ins: every cell can import them, and their layer is provided to actions (injected services)`, async () => {
    const dir = mkdtempSync(`${tmpdir()}/empty-vessel-kernel-`)
    const effect = new URL(import.meta.resolve("effect")).pathname
    writeFileSync(`${dir}/builtins.ts`, [
      `import { Context, Effect, Layer } from ${JSON.stringify(effect)}`,
      `export class Clock extends Context.Service<Clock, { readonly now: Effect.Effect<string> }>()("Clock") {}`,
      `export const layer = Layer.succeed(Clock, { now: Effect.succeed("noon") })`,
      `export const shout = (s: string) => s.toUpperCase()`,
    ].join("\n"))
    const k = open({ dir, builtins: `${dir}/builtins.ts` })
    const r = await run(k, `import { Effect, Clock, shout } from "kernel"\nexport default Effect.gen(function* () { return shout(yield* (yield* Clock).now) })`)
    expect(r).toMatchObject({ status: "ok", value: "NOON" })
    expect(JSON.parse(readFileSync(`${dir}/index.json`, "utf8"))).toHaveLength(1)
  })

  test(`${name}: remember: an expensive Effect runs once across cells, a function once per input; forget drops it; results must be JSON`, async () => {
    let asked = 0
    const host = { systemOne: () => Effect.sync(() => ({ ok: { choice: "yes", confidence: 0.9, n: ++asked } })) }
    const k = open({ dir: mkdtempSync(`${tmpdir()}/empty-vessel-kernel-`), builtins: new URL("../../src/tools/kernel-builtins.ts", import.meta.url).pathname, tsc: `${import.meta.dir}/../../node_modules/.bin/tsc` })
    const q = `{ ok: { question: "ok?", options: { yes: "yes", no: "no" } } }`
    const one = await run(k, `import { systemOne, remember } from "kernel"\nexport const verdict = remember(systemOne("evidence", ${q}))\nexport const about = remember((path: string) => systemOne(path, ${q}))`, host)
    expect(one.status).toBe("ok")

    for (let i = 0; i < 2; i++) await run(k, `import { Effect, verdict, about } from "kernel"\nexport default Effect.gen(function* () { return [yield* verdict, yield* about("a"), yield* about("a"), yield* about("b")] })`, host)
    expect(asked).toBe(3) // verdict once, about("a") once, about("b") once: not 8

    await run(k, `import { forget, verdict } from "kernel"\nexport default forget(verdict)`, host)
    await run(k, `import { verdict } from "kernel"\nexport default verdict`, host)
    expect(asked).toBe(4) // forgotten, so asked again

    // What can change underneath (a file, a command) can't be remembered: a type error.
    const file = await run(k, `import { readText, remember } from "kernel"\nexport const notes = remember(readText("notes.md"))`, host)
    expect(file.status).toBe("type-error")
    const map = await run(k, `import { Effect, systemOne, remember } from "kernel"\nexport const m = remember(systemOne("x", ${q}).pipe(Effect.map((a) => new Map([["a", a]]))))\nexport default m`, host)
    expect(map.status).toBe("error")
    expect(map.error).toContain("remember keeps JSON only")
  }, 60_000) // type-checked: a fresh tsc (plain) can take seconds while the whole suite runs

  test(`${name}: when a cell ends (here: its time limit), host calls still running for it are stopped, not left orphaned`, async () => {
    let stopped = false
    const host = { forever: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { stopped = true }))) }
    const r = await run(fresh({ timeoutMs: 400 }), `import { call } from "kernel"\nexport default call("forever")`, host)
    expect(r.status).toBe("timeout")
    await Bun.sleep(50)
    expect(stopped).toBe(true)
  })

  test(`${name}: a stopped cell's shell commands are killed too (the Worker stops its action before it ends)`, async () => {
    const k = open({ dir: mkdtempSync(`${tmpdir()}/empty-vessel-kernel-`), builtins: new URL("../../src/tools/kernel-builtins.ts", import.meta.url).pathname, timeoutMs: 1000 })
    const r = await run(k, `import { bash } from "kernel"\nexport default bash("sleep 318", 400)`)
    expect(r.status).toBe("timeout")
    await Bun.sleep(500)
    const left = Bun.spawnSync(["pgrep", "-fx", "sleep 318"]).stdout.toString().trim()
    if (left) Bun.spawnSync(["pkill", "-fx", "sleep 318"])
    expect(left).toBe("")
  })

  test(`${name}: a text cell defines a name holding its text exactly (backticks, \${…}, backslashes); later code uses it`, async () => {
    const k = open({ dir: mkdtempSync(`${tmpdir()}/empty-vessel-kernel-`), tsc: `${import.meta.dir}/../../node_modules/.bin/tsc` })
    const python = 'print(f"speedup: {x:.1f}x")\nprint(`done`)  # ${HOME} and \\d stay\n'
    const t = await Effect.runPromise(k.text("reportPy", python))
    expect(t).toMatchObject({ status: "ok", defines: ["reportPy"] })
    expect(t.summary).toBe(`text cell: defined reportPy (3 lines, ${python.length} characters)`)

    expect((await run(k, `import { reportPy } from "kernel"\nexport default reportPy`)).value).toBe(python)
    expect((await run(k, `import { reportPy } from "kernel"\nexport default reportPy.toFixed(1)`)).status).toBe("type-error") // it's a string
    expect((await Effect.runPromise(k.text("not a name", "x"))).status).toBe("error")
  }, 60_000) // type-checked: a fresh tsc (plain) can take seconds while the whole suite runs

  // Two tool sources written in plain code: to the kernel they're just sources, whatever provides them.
  const source = (name: string, tools: Record<string, (args: any) => unknown>) => ({
    name,
    list: Effect.succeed(Object.keys(tools).map((t) => ({ name: t, description: `${name}'s ${t}` }))),
    call: (tool: string, args: unknown) => Effect.try({ try: () => tools[tool]!(args), catch: (e) => (e instanceof Error ? e : new Error(String(e))) }),
  })

  test(`${name}: tool sources: each is a built-in grouped by its name; tools are plain functions; a dashed name becomes a TypeScript name`, async () => {
    const docs = source("docs", { search: (a) => `docs about ${a.q}`, "list-pages": () => ["home", "faq"] })
    const issues = source("issues", { search: (a) => [`issue about ${a.q}`] })
    const k = fresh({ sources: [docs, issues] })

    const r = await run(k, `import { Effect, docs, issues } from "kernel"\nexport default Effect.gen(function* () { return [yield* docs.search({ q: "x" }), yield* issues.search({ q: "x" }), yield* docs.list_pages()] })`)
    expect(r).toMatchObject({ status: "ok", value: ["docs about x", ["issue about x"], ["home", "faq"]] })
  })

  test(`${name}: a tool source's failure comes back as the cell's error, with the tool named`, async () => {
    const k = fresh({ sources: [source("flaky", { go: () => { throw new Error("service down") } })] })
    const r = await run(k, `import { flaky } from "kernel"\nexport default flaky.go()`)
    expect(r.status).toBe("error")
    expect(r.error).toContain("service down")
  })

  test(`${name}: the generated source tools type-check (as empty-vessel runs every cell): results are any, arguments an object`, async () => {
    const k = open({ dir: mkdtempSync(`${tmpdir()}/empty-vessel-kernel-`), tsc: `${import.meta.dir}/../../node_modules/.bin/tsc`, sources: [source("docs", { "list-pages": () => ["home", "faq"] })] })
    const r = await run(k, `import { Effect, docs } from "kernel"\nexport default Effect.gen(function* () { const pages = yield* docs.list_pages(); return pages.length })`)
    expect(r).toMatchObject({ status: "ok", value: 2 })
  }, 60_000) // a type check: a fresh tsc (plain) can take seconds while the whole suite runs

  test(`${name}: with built-ins, cells reach the host only through services: call isn't in their scope`, async () => {
    const k = open({ dir: mkdtempSync(`${tmpdir()}/empty-vessel-kernel-`), builtins: new URL("../../src/tools/kernel-builtins.ts", import.meta.url).pathname, tsc: `${import.meta.dir}/../../node_modules/.bin/tsc` })
    const r = await run(k, `import { call } from "kernel"\nexport default call("systemOne", {})`, { systemOne: () => Effect.succeed("answered") })
    expect(r.status).toBe("type-error")
    expect(r.summary).toContain("call")
  }, 60_000) // type-checked: a fresh tsc (plain) can take seconds while the whole suite runs

  test(`${name}: a built-in the kernel doesn't grant fails the type check before the cell runs; the granted ones still work`, async () => {
    const noShell = { ...ALL, shell: false }
    const denied = await runGranting(noShell, `import { bash } from "kernel"\nexport default bash("echo hi")`)
    expect(denied.status).toBe("type-error")
    expect(denied.summary).toContain("bash")

    const allowed = await runGranting(noShell, `import { now } from "kernel"\nexport default now()`)
    expect(allowed.status).toBe("ok")
  }, 60_000)

  test(`${name}: a service the kernel doesn't grant isn't provided at all, even to a cell that names it by its key`, async () => {
    const sneaky = await runGranting({ ...ALL, shell: false }, `import { Context, Effect } from "kernel"
  export class S extends Context.Service<S, { readonly run: (c: string, t: number) => Effect.Effect<string> }>()("empty-vessel/Shell") {}
  export default S.use((s) => s.run("echo hi", 5))`)
    expect(sneaky.status).toBe("error")
    expect(sneaky.summary).toContain("Shell")
  }, 60_000)

  test(`${name}: read-only files: write and edit aren't built-ins, and the service won't write if reached`, async () => {
    const readOnly = { ...ALL, files: "read-only" as const }
    expect((await runGranting(readOnly, `import { write } from "kernel"\nexport default write("DIR/x.txt", "a")`)).status).toBe("type-error")

    const reached = await runGranting(readOnly, `import { Files } from "kernel"\nexport default Files.use((f) => f.write("DIR/y.txt", "a"))`)
    expect(String(reached.value)).toContain("read-only")
    expect(existsSync(join(reached.dir, "y.txt"))).toBe(false)
  }, 60_000)
}
