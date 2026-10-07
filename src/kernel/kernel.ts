import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { Effect, Fiber } from "effect"
import { checkWithServer, warmChecker } from "./checker"
import { cellProblems } from "./rules"

// The kernel: code runs in cells, and what cells define stays available to later ones. A library: it knows
// nothing about who uses it. The host gives it a folder, optionally a module of
// built-ins (every cell can import its exports) and a table of host functions (cells reach them with `call`).
//
// A cell is a TypeScript module. It imports what it needs from "kernel" (Effect, the built-ins, `call`, `result`, and
// every earlier definition). Its named exports are definitions, kept for later cells; its default export is its
// action (an Effect, a function or a value), run once, and the result is stored as $N. Each cell runs in a fresh
// Worker with only the environment the host allows: files are the kernel's memory, not a live process.
// The rules (src/kernel/rules.ts, guard.ts): the top level only defines things, so
// loading a cell costs nothing and later cells can import every earlier one; side effects go through the built-ins'
// services, so they show in each Effect's requirements.

export type HostFunctions = Readonly<Record<string, (arg: unknown) => Effect.Effect<unknown, unknown>>>

// A tool source: tools from outside (an MCP server, later a CLI or an API), which cells
// use like any other built-in, grouped under the source's name: `yield* posthog.insights_query({ … })`. How the tools
// are provided is the source's business; to the kernel they're a list and a call.
export type SourceTool = { readonly name: string; readonly description: string; readonly inputSchema?: unknown }
export type ToolSource = {
  readonly name: string // a TypeScript name: what cells import
  readonly list: Effect.Effect<ReadonlyArray<SourceTool>, Error>
  readonly call: (tool: string, args: unknown) => Effect.Effect<unknown, Error>
  readonly instructions?: () => string | undefined // how to use it, from the source itself (known once `list` has run)
}
export type KernelOptions = {
  readonly dir: string // where cells, scopes and results live
  readonly builtins?: string // absolute path of a module whose exports every cell can import (and whose `layer`, if any, is provided to actions)
  readonly env?: Readonly<Record<string, string>> // the Worker's environment; default: a few safe variables, never the host's secrets
  readonly timeoutMs?: number // default 10 minutes
  readonly tsc?: string // a TypeScript compiler to type-check each cell before it runs; none: no type check
  readonly typeRoots?: ReadonlyArray<string> // where the type check finds @types/bun; default: next to the kernel's Effect
  readonly sources?: ReadonlyArray<ToolSource> // outside tools, each a built-in grouped under its name
  // The two speed-ups, each on unless turned off (same results either way: test/kernel/kernel.test.ts runs the kernel
  // rules both ways). `languageServer`: the type check from one shared tsc --lsp (src/kernel/checker.ts); off: a fresh
  // tsc per cell. `spareWorker`: the next cell's Worker started ahead; off: started when the cell runs.
  readonly languageServer?: boolean
  readonly spareWorker?: boolean
}
// `rules`: written under the rules above; cells from before them (an old session's) may do work when loaded, so later
// cells don't import them.
export type Cell = { readonly n: number; readonly status: "ok" | "error" | "type-error" | "refused" | "timeout"; readonly defines: ReadonlyArray<string>; readonly rules?: true; readonly summary: string; readonly title?: string }
export type CellResult = Cell & { readonly logs: string; readonly value?: unknown; readonly error?: string }

// The kernel's own files, which cells import and Workers run: next to this source, or, in the compiled empty-vessel (a
// single executable), in its kit, unpacked on disk (scripts/entry.ts sets where, before this module loads).
const KIT = (globalThis as { __emptyVesselKit?: string }).__emptyVesselKit
const EFFECT = KIT ? `${KIT}/node_modules/effect/dist/index.js` : new URL(import.meta.resolve("effect")).pathname // a plain path: TypeScript can't read file:// URLs
const TYPES = `${EFFECT.slice(0, EFFECT.lastIndexOf("/node_modules/") + "/node_modules/".length)}@types` // for the type check: bun's types
const RUNTIME = KIT ? `${KIT}/src/kernel/runtime.ts` : new URL("./runtime.ts", import.meta.url).pathname
const WORKER = KIT ? `${KIT}/src/kernel/worker.ts` : new URL("./worker.ts", import.meta.url).pathname
const SAFE_ENV = ["PATH", "HOME", "LANG", "TERM", "TMPDIR", "USER", "SHELL"] // what a cell may see of the host's environment
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

// "$7 = [120 items] …": a result shortened for a model's context; the whole value stays in results/7.json.
export const summarize = (n: number, value: unknown, max = 4000) => {
  const json = JSON.stringify(value, null, 1) ?? "undefined"
  const what = Array.isArray(value) ? `${value.length} items` : value === null ? "null" : typeof value
  return `$${n} (${what}) = ${json.length > max ? `${json.slice(0, max)}\n[… ${json.length - max} more characters: result(${n}) in a later cell]` : json}`
}

// What a model reads after a cell: its status, what it defined, its value ($N, shortened) and its logs.
export const describeCell = (r: CellResult) =>
  [
    `cell ${r.n}: ${r.status}`,
    r.summary,
    r.logs ? `logs:\n${r.logs.length > 4000 ? `${r.logs.slice(0, 2000)}\n[…]\n${r.logs.slice(-2000)}` : r.logs}` : "",
  ].filter(Boolean).join("\n")

// A cell's imports point at its own scope file, which exports everything a cell may use (latest definition wins).
export const rewriteImports = (code: string, n: number) => code.replace(/(from\s+|import\s*\(\s*)(["'])kernel\2/g, `$1"./scope-${n}.ts"`)

// Everything Effect exports, then by name (so they win over Effect's names, e.g. a built-in called Clock): the kernel's
// call and result, the built-ins, and each earlier definition. A cell's definition wins over a built-in of the same name.
// Every earlier cell written under the rules: loading one only defines things, so offering them all costs nothing.
// A text cell from before them too: its file is only a string constant.
export const underRules = (c: Cell) => c.rules === true || c.summary.startsWith("text cell: defined ")
export const scopeFor = (cells: ReadonlyArray<Cell>, builtins?: string, sources: ReadonlyArray<string> = []) => {
  const latest = new Map<string, number>()
  for (const c of cells) if (c.status === "ok" && underRules(c)) for (const d of c.defines) latest.set(d, c.n)
  const own = builtins ? new Bun.Transpiler({ loader: "ts" }).scan(readFileSync(builtins, "utf8")).exports.filter((e) => e !== "default" && !latest.has(e)) : []

  return [
    `export * from ${JSON.stringify(EFFECT)}`,
    // `call` (the host, untyped) only when there are no built-ins: with them, cells reach the host through their
    // services, so every Effect's requirements say what it touches (and remember can check them).
    `export { ${[...(builtins ? [] : ["call"]), "result"].filter((e) => !latest.has(e)).join(", ")} } from ${JSON.stringify(RUNTIME)}`,
    ...(own.length ? [`export { ${own.join(", ")} } from ${JSON.stringify(builtins)}`] : []),
    ...(sources.filter((s) => !latest.has(s)).length ? [`export { ${sources.filter((s) => !latest.has(s)).join(", ")} } from "./sources.ts"`] : []),
    ...[...latest].map(([name, n]) => `export { ${name} } from "./cell-${n}.ts"`),
  ].join("\n")
}

// A tool's name as a TypeScript name: MCP tools are often dashed (`insights-query` becomes `insights_query`).
export const toolName = (name: string) => {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, "_")
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned
}

// sources.ts: one export per tool source, an object of its tools; each tool uses the Sources service (the worker
// provides it as calls to the host's $source, which routes it to the source with the tool's own name). ponytail: arguments are an object and results `any`; types from the tools'
// schemas come later (tool-sources.md).
export const sourcesModule = (lists: ReadonlyArray<{ source: string; tools: ReadonlyArray<SourceTool> }>) =>
  [
    `import type { Effect } from ${JSON.stringify(EFFECT)}`,
    `import { Sources } from ${JSON.stringify(RUNTIME)}`,
    ...lists.map(({ source, tools }) => {
      const seen = new Set<string>()
      const entries = tools.map((t) => {
        let key = toolName(t.name)
        while (seen.has(key)) key = `${key}_`
        seen.add(key)
        const doc = t.description.replace(/\*\//g, "*\\/").split("\n")[0]!.slice(0, 200)
        return `  /** ${doc} */\n  ${key}: (args: Record<string, unknown> = {}): Effect.Effect<any, Error, Sources> => Sources.use((s) => s.call(${JSON.stringify(source)}, ${JSON.stringify(t.name)}, args)),`
      })
      return `export const ${source} = {\n${entries.join("\n")}\n}`
    }),
  ].join("\n")

// The compiler options every check uses. tsconfig.json (the folder's cells, for the language server) and
// tsconfig.check.json (one cell, for a fresh tsc) share them.
const compilerOptions = (options: KernelOptions) => ({ strict: true, noEmit: true, incremental: true, tsBuildInfoFile: "tsbuildinfo", module: "preserve", moduleResolution: "bundler", target: "esnext", skipLibCheck: true, allowImportingTsExtensions: true, types: ["bun"], typeRoots: options.typeRoots ?? [TYPES] })

// The type check's output if it found problems (or couldn't run), undefined if the cell is fine: from the folder's
// language server (src/kernel/checker.ts) when it answers, else a fresh tsc for this cell.
const typeCheck = (options: KernelOptions, file: string, changed: ReadonlyArray<string>) =>
  Effect.tryPromise(async () => {
    const served = options.languageServer === false ? undefined : await checkWithServer(options.tsc!, options.dir, file, changed)
    if (served !== undefined) return served || undefined

    writeFileSync(`${options.dir}/tsconfig.check.json`, JSON.stringify({ compilerOptions: compilerOptions(options), files: [file] }))
    const proc = Bun.spawn([options.tsc!, "-p", `${options.dir}/tsconfig.check.json`], { cwd: options.dir, stdout: "pipe", stderr: "pipe" })
    const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
    const exit = await proc.exited
    return exit === 0 ? undefined : out.trim() || `the type check failed: compiler exited with code ${exit} without diagnostics`
  }).pipe(Effect.catch((e) => Effect.succeed(`the type check couldn't run: ${e}`)))

const SPARE_IDLE_MS = 60_000 // how long a Worker started ahead waits for a cell before it ends itself

// A fresh Worker for one cell. It loads the kernel's runtime (Effect, the guard) while the type check runs, and gets the
// cell only after it passes: the two overlap instead of adding up.
const startWorker = (options: KernelOptions) => {
  const env = options.env ?? Object.fromEntries(SAFE_ENV.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])))
  return new Worker(WORKER, { env: { ...env, KERNEL_DIR: options.dir } }) as Worker & Pick<Bun.Worker, "ref" | "unref"> // Bun's, whichever lib types win
}

// Run one cell in its Worker: host calls answered, logs collected, stopped at the timeout or when interrupted.
const runInWorker = (options: KernelOptions, file: string, host: HostFunctions, worker: Worker) =>
  Effect.callback<{ defines: ReadonlyArray<string>; value?: string; ran?: boolean; error?: string; logs: string; timedOut?: boolean }>((resume) => {
    const logs: Array<string> = []
    const calls = new Set<Fiber.Fiber<unknown, unknown>>() // host calls still in flight for this cell
    let finished = false
    // `stopping`: the cell is being stopped (time limit, interruption), not finished: ask the Worker to stop its action
    // first, so commands it started are killed, then end it (after 2 s at most).
    const finish = (r: { defines: ReadonlyArray<string>; value?: string; ran?: boolean; error?: string; timedOut?: boolean }, stopping = false) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (stopping) {
        const end = setTimeout(() => worker.terminate(), 2000)
        worker.onmessage = (e: MessageEvent) => { if (e.data?.type === "stopped") { clearTimeout(end); worker.terminate() } }
        worker.postMessage({ type: "stop" })
      } else worker.terminate()
      // The cell is over (done, timed out, stopped): so is anything the host was still doing for it. Otherwise a
      // host call (e.g. a sub-agent) would run on with nobody to answer.
      for (const call of calls) Effect.runFork(Fiber.interrupt(call))
      resume(Effect.succeed({ ...r, logs: logs.join("\n") }))
    }
    const timer = setTimeout(() => finish({ defines: [], timedOut: true, error: `stopped after ${options.timeoutMs ?? 600_000} ms` }, true), options.timeoutMs ?? 600_000)

    worker.onmessage = (e: MessageEvent) => {
      const m = e.data
      if (m.type === "log") logs.push(m.text)
      else if (m.type === "done") finish(m)
      else if (m.type === "call") {
        const fn = host[m.fn]
        const reply = fn
          ? fn(m.arg).pipe(Effect.match({ onSuccess: (value) => ({ id: m.id, value }), onFailure: (err) => ({ id: m.id, error: String(err) }) }))
          : Effect.succeed({ id: m.id, error: `no host function "${m.fn}" (there are: ${Object.keys(host).join(", ") || "none"})` })
        const call: Fiber.Fiber<unknown, unknown> = Effect.runFork(reply.pipe(
          Effect.tap((r) => Effect.sync(() => { if (!finished) worker.postMessage({ type: "reply", ...r }) })),
          Effect.ensuring(Effect.sync(() => { calls.delete(call) })),
        ))
        calls.add(call)
      }
    }
    worker.onerror = (e: ErrorEvent) => finish({ defines: [], error: e.message })
    worker.addEventListener("close", () => finish({ defines: [], error: "the cell's worker exited before finishing (process.exit?)" }))
    worker.postMessage({ type: "run", file, builtins: options.builtins })
    return Effect.sync(() => finish({ defines: [], error: "stopped" }, true)) // interrupted (e.g. Ctrl+C): the worker goes too
  })

export const makeKernel = (given: KernelOptions) => {
  const options = { ...given, ...(given.tsc ? { tsc: resolve(given.tsc) } : {}) } // the check runs in dir: a relative path would miss
  const index = `${options.dir}/index.json`
  const cells = (): ReadonlyArray<Cell> => (existsSync(index) ? JSON.parse(readFileSync(index, "utf8")) : [])

  // The next cell's Worker, started ahead (when the kernel opens, and after each cell) so its runtime loads while System
  // Two thinks: a cell then doesn't wait for it. Still one fresh Worker per cell; only the start moves earlier. It
  // doesn't keep the process alive (unref), and ends itself after SPARE_IDLE_MS unused, so a kernel that's dropped (a
  // temporary one: promote's check, System One's tool run) leaves nothing behind for long, and needs no close.
  let spare: { readonly worker: ReturnType<typeof startWorker>; readonly idle: ReturnType<typeof setTimeout> } | undefined
  const prestart = () => {
    if (spare || options.spareWorker === false) return
    const worker = startWorker(options)
    worker.unref()
    const idle = setTimeout(() => { if (spare?.worker === worker) spare = undefined; worker.terminate() }, SPARE_IDLE_MS)
    idle.unref()
    spare = { worker, idle }
  }
  const take = () => {
    if (!spare) return startWorker(options)
    const { worker, idle } = spare
    spare = undefined
    clearTimeout(idle)
    worker.ref() // a running cell keeps the process alive, as before
    return worker
  }
  prestart()

  // The folder's type checker, warming up alongside the spare (its tsconfig.json: every cell in the folder).
  if (options.tsc && options.languageServer !== false) {
    mkdirSync(options.dir, { recursive: true })
    writeFileSync(`${options.dir}/tsconfig.json`, JSON.stringify({ compilerOptions: compilerOptions(options) }))
    warmChecker(options.tsc, options.dir)
  }

  // Run code as the next cell and keep what it defines.
  const run = (code: string, host: HostFunctions = {}, title?: string) =>
    Effect.gen(function* () {
      mkdirSync(`${options.dir}/results`, { recursive: true })
      const before = cells()
      const n = before.length + 1
      const file = `${options.dir}/cell-${n}.ts`
      // The tool sources' tools, listed (each source keeps its own list after the first time) and written as built-ins.
      const sources = options.sources ?? []
      const lists = yield* Effect.forEach(sources, (s) => s.list.pipe(Effect.map((tools) => ({ source: s.name, tools })), Effect.orElseSucceed(() => ({ source: s.name, tools: [] }))), { concurrency: "unbounded" })
      if (sources.length) writeFileSync(`${options.dir}/sources.ts`, sourcesModule(lists))
      writeFileSync(`${options.dir}/scope-${n}.ts`, scopeFor(before, options.builtins, sources.map((s) => s.name)))
      // Calls to a source's tools reach it through the host function $source.
      const withSources: HostFunctions = sources.length ? { ...host, $source: (arg) => {
        const { source, tool, args } = arg as { source: string; tool: string; args: unknown }
        const found = sources.find((s) => s.name === source)
        return found ? found.call(tool, args).pipe(Effect.mapError((e) => new Error(`${source}.${toolName(tool)}: ${e.message}`))) : Effect.fail(new Error(`no tool source named ${source}`))
      } } : host
      writeFileSync(file, rewriteImports(code, n))

      const save = (cell: CellResult) => {
        writeFileSync(index, JSON.stringify([...before, { n: cell.n, status: cell.status, defines: cell.defines, ...(cell.rules ? { rules: true } : {}), summary: cell.summary, ...(title ? { title } : {}) }], null, 1))
        return { ...cell, ...(title ? { title } : {}) }
      }

      // Syntax (instant, Bun's parser), the rules (src/kernel/rules.ts: "refused"), then types (a TypeScript compiler,
      // if given): problems go back before anything runs.
      const syntax = (() => { try { new Bun.Transpiler({ loader: "ts" }).scan(code); return undefined } catch (e) { return String(e) } })()
      const refused = syntax ? undefined : cellProblems(code).join("\n") || undefined
      if (refused) return save({ n, status: "refused", defines: [], summary: `not run: it breaks the kernel's rules:\n${refused}`, logs: "", error: refused })
      if (syntax) return save({ n, status: "type-error", defines: [], summary: syntax.slice(0, 4000), logs: "", error: syntax })
      const worker = take()
      const changed = [`${options.dir}/scope-${n}.ts`, ...(sources.length ? [`${options.dir}/sources.ts`] : [])]
      const types = options.tsc ? yield* typeCheck(options, file, changed).pipe(Effect.onInterrupt(() => Effect.sync(() => worker.terminate()))) : undefined
      if (types) {
        worker.terminate()
        return save({ n, status: "type-error", defines: [], summary: types.slice(0, 4000), logs: "", error: types })
      }

      const r = yield* runInWorker(options, file, withSources, worker)
      if (r.error !== undefined) return save({ n, status: r.timedOut ? "timeout" : "error", defines: [], summary: r.error, logs: r.logs, error: r.error })

      const value = r.value === undefined ? undefined : JSON.parse(r.value)
      if (r.ran) writeFileSync(`${options.dir}/results/${n}.json`, r.value ?? "null")

      const summary = [r.defines.length ? `defined: ${r.defines.join(", ")}` : "", r.ran ? summarize(n, value) : ""].filter(Boolean).join("\n")
      return save({ n, status: "ok", defines: r.defines, rules: true, summary, logs: r.logs, value })
    }).pipe(Effect.ensuring(Effect.sync(prestart)))

  // A text cell: `content` as-is (Python, Markdown, a prompt, a rubric…) under a name, for later code cells to use,
  // e.g. write(path, reportPy). It never passes through TypeScript, so backticks, ${…} and backslashes stay as they
  // are: cell-N.ts defines it as a string constant (JSON-escaped), which costs nothing to load.
  const text = (name: string, content: string, title?: string) =>
    Effect.sync((): CellResult => {
      const before = cells()
      const n = before.length + 1
      const summary = `text cell: defined ${name} (${content.split("\n").length} lines, ${content.length} characters)`
      const save = (cell: CellResult) => {
        writeFileSync(index, JSON.stringify([...before, { n: cell.n, status: cell.status, defines: cell.defines, ...(cell.rules ? { rules: true } : {}), summary: cell.summary, ...(title ? { title } : {}) }], null, 1))
        return { ...cell, ...(title ? { title } : {}) }
      }

      if (!IDENTIFIER.test(name)) return save({ n, status: "error", defines: [], summary: `"${name}" can't be a name: use letters, digits and _ (e.g. reportPy)`, logs: "", error: "bad name" })
      writeFileSync(`${options.dir}/cell-${n}.ts`, `export const ${name}: string = ${JSON.stringify(content)}\n`)
      return save({ n, status: "ok", defines: [name], rules: true, summary, logs: "" })
    })

  return { run, text, cells }
}
