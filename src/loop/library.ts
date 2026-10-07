import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { type Cell, type HostFunctions, scopeFor } from "../kernel/kernel"
import { Kernel } from "../tools/kernel-service"
import { cellProblems } from "../kernel/rules"
import { withLock } from "../base/files"
import { ALL, allGranted, allows, type Grants, has, NEEDS } from "../base/grants"
import { EMPTY_VESSEL_HOME } from "../base/home"
import { projectDir } from "../base/project"
import { verdictFor, withUnclear } from "../tools/judge-rules"
import { record } from "./pool"
import { kernelSources } from "./sources"
import type { SystemOne } from "../system-one/systemone"
import { Fill } from "../system-two/fill"

// The shared library: definitions System Two promoted, so System One can pick them in
// later turns and its kernel runs them with no LLM. Per project, next to the saved checks; each entry's module is a
// copy of the cell that defined it (sessions can be deleted), importing only Effect and empty-vessel's built-ins.

// empty-vessel's built-ins and the TypeScript compiler cells are checked with: in the repo, or in the compiled empty-vessel's kit
// (src/kernel/kernel.ts).
const KIT = (globalThis as { __emptyVesselKit?: string }).__emptyVesselKit
export const BUILTINS = KIT ? `${KIT}/src/tools/kernel-builtins.ts` : new URL("../tools/kernel-builtins.ts", import.meta.url).pathname
export const TSC = KIT ? `${KIT}/tsc/lib/tsc` : new URL("../../node_modules/.bin/tsc", import.meta.url).pathname

export const Entry = Schema.Struct({
  name: Schema.String,
  description: Schema.String, // what System One reads to decide when to pick it
  file: Schema.String,
  from: Schema.String, // the session that promoted it
  for: Schema.optionalKey(Schema.Literals(["systemOne", "systemTwo"])), // missing: a System One tool (entries from before the pool)
  // A System One tool's parameters (name → what it is), filled from each request (fillParameters); missing: it takes the request
  parameters: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})
export type Entry = typeof Entry.Type

// The library's System One tools (System One's options) and System Two helpers (names in its prompt).
export const systemOneTools = (entries: ReadonlyArray<Entry>) => entries.filter((e) => e.for !== "systemTwo")
export const helpers = (entries: ReadonlyArray<Entry>) => entries.filter((e) => e.for === "systemTwo")

const RESERVED = ["gather", "escalate"] // System One's own options
const NAME = /^[a-z][A-Za-z0-9]*$/

// The pool (src/loop/pool.ts): candidates that have to prove themselves; `for` says which system they're offered to.
export const PoolEntry = Schema.Struct({ ...Entry.fields, for: Schema.Literals(["systemOne", "systemTwo"]) })
// A scratch folder for `use`, deleted afterwards however it ends (checking a tool, trying a proposal): they used to be
// left in the temp folder, hundreds of them.
export const withScratch = <A, E, R>(prefix: string, use: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(Effect.sync(() => mkdtempSync(join(tmpdir(), prefix))), use, (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })))

// Whole-file writes: a temp file renamed over the real one, so a reader never sees half a file (and loads [] from it).
const writeWhole = (file: string, text: string) => { const temp = `${file}.${crypto.randomUUID()}.tmp`; writeFileSync(temp, text); renameSync(temp, file) }
export const savePool = (dir: string, entries: ReadonlyArray<PoolEntry>) => { mkdirSync(dir, { recursive: true }); writeWhole(join(dir, "pool.json"), JSON.stringify(entries, null, 1)) }
export const saveLibrary = (dir: string, entries: ReadonlyArray<Entry>) => { mkdirSync(dir, { recursive: true }); writeWhole(join(dir, "library.json"), JSON.stringify(entries, null, 1)) }

// Every change to the library and pool goes through here: under one lock (other empty-vessel processes, background
// end-of-turn work), both files are read fresh, `change` returns their new contents (or undefined: no change) and a
// result, and both are written. Nothing writes from a copy it read earlier.
export const updateTools = <A>(dir: string, change: (library: ReadonlyArray<Entry>, pool: ReadonlyArray<PoolEntry>) => { library?: ReadonlyArray<Entry>; pool?: ReadonlyArray<PoolEntry>; result: A }) =>
  withLock(join(dir, "tools"), Effect.sync(() => {
    const next = change(loadLibrary(dir), loadPool(dir))
    if (next.library) saveLibrary(dir, next.library)
    if (next.pool) savePool(dir, next.pool)
    return next.result
  }))
export type PoolEntry = typeof PoolEntry.Type
// A tool whose module breaks the kernel's rules (one made before them: raw file reads, Bun, node: imports) is left
// out wherever tools are loaded (offered, listed, imported): loading it could do work, or fail, for every cell. The
// next write of the pool or library drops it for good.
export const LIBRARY_IMPORTS = /^(kernel|\.\/scope(-\d+)?\.ts)$/
const followsRules = (file: string) => !existsSync(file) || cellProblems(readFileSync(file, "utf8"), LIBRARY_IMPORTS).length === 0

// Entries saved before System One had its generic name say `for: "jev"`: read as "systemOne".
const upgraded = (raw: unknown) => (Array.isArray(raw) ? raw.map((e) => (e?.for === "jev" ? { ...e, for: "systemOne" } : e)) : raw)
const readEntries = (file: string) => upgraded(JSON.parse(readFileSync(file, "utf8")))

export const loadPool = (dir: string): ReadonlyArray<PoolEntry> => {
  try { return Schema.decodeUnknownSync(Schema.Array(PoolEntry))(readEntries(join(dir, "pool.json"))).filter((e) => followsRules(e.file)) } catch { return [] }
}

export const libraryDir = (root: string, home = EMPTY_VESSEL_HOME) => join(projectDir(root, home), "library")

// The library's entries, or none if it's missing or unreadable (a broken file must never stop a turn).
export const loadLibrary = (dir: string): ReadonlyArray<Entry> => {
  try { return Schema.decodeUnknownSync(Schema.Array(Entry))(readEntries(join(dir, "library.json"))).filter((e) => followsRules(e.file)) } catch { return [] }
}

// A module of empty-vessel's built-ins plus these library definitions, each by name (Bun's export scan doesn't see
// `export *`): the built-ins of System One's kernel, and of the kernel a promotion is checked in.
// A name listed twice (in the library and the pool) is exported once, the first: a duplicate export would stop Bun
// loading the module, and every cell with it.
// `g`: what the kernel grants (config.json's kernel.tools): only those built-ins are exported, a library tool that uses
// another isn't, and the services' layer provides only the granted ones (src/tools/kernel-builtins.ts layerFor).
export const builtinsModule = (entries: ReadonlyArray<{ name: string; file: string }>, g: Grants = ALL) => {
  const own = new Bun.Transpiler({ loader: "ts" }).scan(readFileSync(BUILTINS, "utf8")).exports.filter((e) => e !== "default")
  const granted = allGranted(g) ? own : own.filter((e) => allows(g, e) && e !== "layer")
  const once = entries.filter((e, i) => entries.findIndex((f) => f.name === e.name) === i && !own.includes(e.name) && usableWith(g)(e))
  return [
    `export { ${granted.join(", ")} } from ${JSON.stringify(BUILTINS)}`,
    ...(allGranted(g) ? [] : [`import { layerFor } from ${JSON.stringify(BUILTINS)}`, `export const layer = layerFor(${JSON.stringify(g)})`]),
    ...once.map((e) => `export { ${e.name} } from ${JSON.stringify(e.file)}`),
  ].join("\n")
}

// What a library tool's module uses of the built-ins (its imports from "kernel", or from its scope), as needs; a kernel
// granting `g` offers only the tools whose needs it grants, to either system. Reliable for what a tool imports by name,
// which the type check makes the only way to reach a built-in; a tool that reached one otherwise would still find its
// service missing when it runs.
const needsOf = (file: string) => { try { return namesFrom(readFileSync(file, "utf8"), /(?:kernel|\.\/scope(?:-\d+)?\.ts)/).flatMap((n) => (NEEDS[n] ? [NEEDS[n]!] : [])) } catch { return [] } }
export const usableWith = (g: Grants) => (e: { readonly file: string }) => allGranted(g) || needsOf(e.file).every((n) => has(g, n))

// A kernel's built-ins file, written fresh from the library as it is now (so it never misses a built-in added since
// the last promote): System Two's kernel and System One's both use one. Library and pool tools alike.
// The library's scope.ts is rewritten too: it holds this checkout's absolute paths, so one written by another
// checkout (a worktree since deleted) would break every cell that imports a library tool.
export const writeBuiltins = (file: string, dir: string, g: Grants = ALL) => {
  if (existsSync(join(dir, "scope.ts"))) writeFileSync(join(dir, "scope.ts"), scopeFor([], BUILTINS))
  writeFileSync(file, builtinsModule([...loadLibrary(dir), ...loadPool(dir)], g)) // pool tools too: they're offered
  return file
}

// The cell System One's kernel runs for a pick: the definition on the goal (an Effect, a promise or a plain value), or,
// for a tool with parameters, on its arguments (the type check says it takes exactly those).
export const pickCell = (name: string, goal: string, args?: Readonly<Record<string, string>>) =>
  [
    `import { Effect, ${name} } from "kernel"`,
    `const run: (input: ${args ? `{ ${Object.keys(args).map((k) => `${k}: string`).join("; ")} }` : "string"}) => unknown = ${name}`,
    `export default Effect.suspend(() => { const r = run(${JSON.stringify(args ?? goal)}); return Effect.isEffect(r) ? r : Effect.promise(async () => r) })`,
  ].join("\n")

// A tool's parameters filled from a request by the small model (Fill), each a string or null when the request doesn't
// say: wording doesn't matter to it, unlike a regex in the tool's code (the recurring-requests benchmark: one tool in
// five survived a second phrasing). Returns the arguments and which parameters are missing (the tool isn't run then).
export const fillParameters = (name: string, parameters: Readonly<Record<string, string>>, request: string) =>
  Effect.gen(function* () {
    const schema = Schema.Struct(Object.fromEntries(Object.entries(parameters).map(([k, d]) => [k, Schema.NullOr(Schema.String).annotate({ description: `${d} (null if the request doesn't say)` })])))
    const { args, tokens } = yield* (yield* Fill).fill(name, schema, request)

    const values = args as Readonly<Record<string, string | null>>
    const missing = Object.keys(parameters).filter((k) => !values[k]?.trim())
    return { args: Object.fromEntries(Object.keys(parameters).map((k) => [k, values[k]?.trim() ?? ""])), missing, tokens }
  })

// Names a cell imports from its scope (a saved cell), or from "kernel" (as System Two wrote it).
const namesFrom = (code: string, source: RegExp) =>
  [...code.matchAll(new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*["']${source.source}["']`, "g"))]
    .flatMap((m) => m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, "")).filter(Boolean))
const importedNames = (code: string) => namesFrom(code, /\.\/scope-\d+\.ts/)
export const kernelImports = (code: string) => namesFrom(code, /kernel/)

// The rubric System One grades a new tool's description against (user, 2026-09-29): what System One will later pick by is only this
// text, so it must be specific, true to the code, warn off close requests (a request using its words about a different
// subject otherwise matches: a dependency's version vs this package's), and stand apart from the other tools.
export const RUBRIC = {
  specific: "Does the description say exactly what kind of request this tool answers, naming what it reads or reports (a file, a field, a command)?",
  matches: "Does the tool's code do what the description says it does?",
  notFor: "Does the description also say which close requests it doesn't answer, ones its words could be mistaken for (e.g. a package version tool: not a dependency's version)?",
  distinct: "Is it clear from the descriptions when to pick this tool rather than each of the other library tools listed?",
  // The example run can "succeed" while its command failed (bash returns "exit 1 …" as text): System One reads the result.
  works: "Did the example run give a real result, not an error, a failed command (e.g. exit 1) or a failure message?",
  // A tool with the example's value written into its code answers that one request again, never the next of its kind.
  general: "Does the code take what varies (a name, a number, a file) from its parameters (or, with none, the request), rather than having the example's value written into it?",
} as const
// A System Two tool is a helper it calls itself: its description must say what it does and how to call it; System One never
// picks it, so "not for" and "distinct" don't apply.
export const RUBRIC_TWO = {
  specific: "Does the description say exactly what this helper does and how to call it (its arguments and what it returns)?",
  matches: RUBRIC.matches,
  works: RUBRIC.works,
} as const
const YES_NO = { yes: "Yes", no: "No" }

// System One grades it (host.systemOne, one call; no System One in the host, e.g. a test: not graded). A criterion fails only on a
// confident no (the doubt rule: a low-confidence answer is unsure, not a fail). Returns the failed criteria.
export const gradeDescription = (host: HostFunctions, tool: { name: string; description: string }, code: string, example: { request: string; result: string }, others: ReadonlyArray<Entry>, rubric: Readonly<Record<string, string>> = RUBRIC) =>
  Effect.gen(function* () {
    if (!host.systemOne) return []
    const evidence = [
      `A new tool for the library. Name: ${tool.name}`,
      `Description: ${tool.description}`,
      `Its code:\n${code}`,
      `On the example "${example.request}" it gave: ${example.result}`,
      `The other library tools:\n${others.map((e) => `- ${e.name}: ${e.description}`).join("\n") || "(none)"}`,
    ].join("\n\n")
    const questions = withUnclear(Object.fromEntries(Object.entries(rubric).map(([k, q]) => [k, { question: q, options: YES_NO }])))

    const answers = (yield* host.systemOne({ evidence, questions }).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, { choice: string; confidence: number }>
    return Object.keys(rubric).filter((k) => verdictFor(answers[k]?.choice ?? "", answers[k]?.confidence ?? 0, YES_NO) === "no")
  })

// `for`: a System One tool (takes the request, gives the answer; `example` is a request) or a System Two tool (a helper with
// any arguments; `example` is a call, e.g. grepSource("TODO")). `to`: the pool (it has to prove itself) or the library.
// `parameters` (System One tools only): name → what it is; the tool takes them as one object of strings, filled from each request.
type Promote = { readonly name: string; readonly description: string; readonly example: string; readonly for?: "systemOne" | "systemTwo"; readonly parameters?: Readonly<Record<string, string>> }

// What a tool may depend on (user, 2026-09-29, "for now"): nothing new. It may not install packages, and it may only
// import Node's and Bun's built-ins, "kernel", and packages the project already has (they resolve from its folder).
// npx/bunx only run what the project has installed (node_modules/.bin): `npx jest` in a project with jest is fine;
// a tool it would download, an explicit -y/--package, or a name it can't read (built at run time) isn't.
// Returns why not, or undefined. ponytail: text patterns; a tool could still fetch code in ways these don't see.
const INSTALLS = /\b(npm|pnpm|yarn|bun|pip3?)\b[^\n]{0,40}?\b(install|add)\b/
const RUNNER = /\b(?:npx|bunx)\b((?:\s+-{1,2}[\w-]+)*)\s+([@\w][\w./@-]*)?/g
const notInstalled = (code: string, root: string) =>
  [...code.matchAll(RUNNER)].find(([, flags, tool]) => !tool || /(^|\s)(-y|--yes|-p|--package)\b/.test(flags ?? "") ||
    !existsSync(join(root, "node_modules", ".bin", tool.replace(/(.)@[^/]*$/, "$1").split("/").at(-1)!)))
export const newDependencies = (code: string, root: string) => {
  if (INSTALLS.test(code)) return `it installs packages (${code.match(INSTALLS)![0]})`
  const runs = notInstalled(code, root)
  if (runs) return `it installs packages (${runs[0].trim()}: ${runs[2] ? `${runs[2]} isn't installed in this project` : "can't tell what it runs"})`

  const specifiers = [...code.matchAll(/\bfrom\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1] ?? m[2] ?? m[3]!)
  const builtin = (s: string) => s.startsWith("node:") || s.startsWith("bun") || s.startsWith(".") || s.startsWith("/") || s === "kernel" || /^\.\/scope/.test(s)
  const missing = specifiers.filter((s) => !builtin(s)).filter((s) => { try { Bun.resolveSync(s, root); return false } catch { return true } })
  return missing.length ? `it needs packages this project doesn't have (${[...new Set(missing)].join(", ")})` : undefined
}

// The cell that runs a System Two tool's example call once, as promote's check.
const exampleCell = (name: string, call: string) =>
  [
    `import { Effect, ${name} } from "kernel"`,
    `export default Effect.suspend(() => { const r: unknown = (${call}); return Effect.isEffect(r) ? r : Effect.promise(async () => r) })`,
  ].join("\n")

// promote: make one of System Two's definitions an option for System One. Code checks it (the maker isn't the
// checker): it exists, it's self-contained (earlier definitions don't come along), it takes the goal, nothing, or its
// `parameters` (filled from `example` through host.fill, as they will be from each request), it runs once on `example` in a fresh kernel, and System One grades its description (RUBRIC). Returns what happened, as text.
// ponytail: definitions that use text cells or stored values must be inlined first; no versions, a same-name promote replaces.
export const promote = (dir: string, kernelDir: string, from: string, host: HostFunctions, args: Promote, to: "pool" | "library" = "library") =>
  Effect.gen(function* () {
    const kind = args.for ?? "systemOne"
    const inLibrary = (library: ReadonlyArray<Entry>) => to === "pool" && library.some((e) => e.name === args.name)
    const taken = `"${args.name}" is already a library tool: pick another name (a new tool can't replace one that proved itself)`
    if (inLibrary(loadLibrary(dir))) return taken
    if (!NAME.test(args.name) || RESERVED.includes(args.name)) return `"${args.name}" can't be promoted under that name: use a camelCase name other than ${RESERVED.join(", ")}`
    if (!args.description.trim()) return "give a description: it's what System One reads to decide when to pick it"
    const parameters = kind === "systemOne" && args.parameters && Object.keys(args.parameters).length ? args.parameters : undefined
    const badNames = Object.keys(parameters ?? {}).filter((k) => !NAME.test(k))
    if (badNames.length) return `parameter names must be camelCase: ${badNames.join(", ")}`

    const cells: ReadonlyArray<Cell> = existsSync(join(kernelDir, "index.json")) ? JSON.parse(readFileSync(join(kernelDir, "index.json"), "utf8")) : []
    const cell = cells.findLast((c) => c.status === "ok" && c.defines.includes(args.name))
    if (!cell) return `no definition named ${args.name} in your kernel`

    const code = readFileSync(join(kernelDir, `cell-${cell.n}.ts`), "utf8")
    const earlier = new Set(cells.filter((c) => c.n < cell.n && c.status === "ok").flatMap((c) => c.defines))
    const library = new Set([...loadLibrary(dir), ...loadPool(dir)].map((e) => e.name))
    const tools = importedNames(code).filter((n) => library.has(n) && !earlier.has(n))
    if (tools.length) return `${args.name} uses library tools (${tools.join(", ")}); library tools can't use each other yet. Inline what it needs, then promote it.`

    const broken = cellProblems(code, LIBRARY_IMPORTS)
    if (broken.length) return `not promoted: its cell breaks the kernel's rules:\n${broken.join("\n")}`

    const extra = newDependencies(code, process.cwd())
    if (extra) return `not promoted: ${extra}. Library tools may only use what's already here (Node and Bun built-ins, the kernel's built-ins, this project's packages), for now.`

    const needs = importedNames(code).filter((n) => earlier.has(n))
    if (needs.length) return `${args.name} isn't self-contained: its cell uses ${needs.join(", ")} from earlier cells. Put what it needs into one cell (the library only has Effect and the built-ins), then promote it.`

    // The copy imports a scope of Effect and the built-ins only, then is checked in a fresh kernel, in a scratch folder
    // that's deleted afterwards (accepted or not: the accepted module is copied out first).
    return yield* withScratch("empty-vessel-promote-", (vet) => Effect.gen(function* () {
      const candidate = join(vet, `${args.name}.ts`)
      writeFileSync(join(vet, "scope.ts"), scopeFor([], BUILTINS))
      writeFileSync(candidate, code.replace(/(["'])\.\/scope-\d+\.ts\1/g, `"./scope.ts"`))
      const others = loadLibrary(dir).filter((e) => e.name !== args.name)
      const pool = loadPool(dir).filter((e) => e.name !== args.name)
      writeFileSync(join(vet, "builtins.ts"), builtinsModule([...others, ...pool, { name: args.name, file: candidate }]))

      // A System One tool must take the request, or its parameters filled from the example request (the pick cell's type
      // check says so); a System Two tool runs its example call.
      let filled: Readonly<Record<string, string>> | undefined
      if (parameters) {
        const got = host.fill ? ((yield* host.fill({ name: args.name, parameters, request: args.example }).pipe(Effect.orElseSucceed(() => undefined))) as { args: Record<string, string>; missing: ReadonlyArray<string> } | undefined) : undefined
        if (!got || got.missing.length) return `not promoted: its parameters (${(got?.missing ?? Object.keys(parameters)).join(", ")}) couldn't be filled from the example request "${args.example}". Describe each so it can be read from a request like it.`
        filled = got.args
      }
      const check = kind === "systemOne" ? pickCell(args.name, args.example, filled) : exampleCell(args.name, args.example)
      const tried = yield* (yield* Kernel).open({ dir: join(vet, "kernel"), builtins: join(vet, "builtins.ts"), tsc: TSC, sources: kernelSources() }).run(check, host)
      if (tried.status !== "ok") return `not promoted: running ${args.name} on the example failed (${tried.status}):\n${tried.summary.slice(0, 2000)}`

      const rubric: Readonly<Record<string, string>> = kind === "systemOne" ? RUBRIC : RUBRIC_TWO
      const described = parameters ? { ...args, description: `${args.description}\nParameters, filled from each request: ${Object.entries(parameters).map(([k, d]) => `${k} (${d})`).join(", ")}` } : args
      const failed = yield* gradeDescription(host, described, code, { request: `${args.example}${filled ? ` (filled: ${JSON.stringify(filled)})` : ""}`, result: tried.summary.slice(0, 500) }, kind === "systemOne" ? [...others, ...pool.filter((e) => e.for === "systemOne")] : [], rubric)
      if (failed.length) return `not promoted: System One graded the description and it falls short on:\n${failed.map((k) => `- ${rubric[k]}`).join("\n")}\nRewrite the description, then promote again.`

      // Accepted: the module next to its scope, and an entry in the pool or the library (a same-name one there is
      // replaced; into the library, it also leaves the pool). Under the lock, from the files as they are now.
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "scope.ts"), scopeFor([], BUILTINS))
      const file = join(dir, `${args.name}.ts`)
      const entry = { name: args.name, description: args.description, file, from, ...(parameters ? { parameters } : {}) }
      const refused = yield* updateTools(dir, (library, pool) => {
        if (inLibrary(library)) return { result: taken } // it graduated while this one was being checked
        copyFileSync(candidate, file)
        return to === "pool"
          ? { pool: [...pool.filter((e) => e.name !== args.name), { ...entry, for: kind }], result: undefined }
          : { library: [...library.filter((e) => e.name !== args.name), { ...entry, for: kind }], pool: pool.filter((e) => e.name !== args.name), result: undefined }
      })
      if (refused) return refused
      if (to === "pool") record(dir, { session: from, turn: 0, tool: args.name, for: kind, event: "added" }) // a fresh record, even for a name used before

      const who = kind === "systemOne" ? "System One" : "you (System Two)"
      return to === "pool"
        ? `added ${args.name} to the pool: it will be offered to ${who} in later turns, and kept if it helps. On the example it gave: ${tried.summary.slice(0, 500)}`
        : `promoted ${args.name}: System One can now pick it when "${args.description}". On the example it gave: ${tried.summary.slice(0, 500)}`
    }))
  })

// Which library tools System One is shown this turn: with more than SHOW, one System One call scores each tool's description
// against the goal (yes/no, all in one call) and the best SHOW at SHOW_AT or more stay. Picking among a few is where
// System One is reliable; tools System Two loaded this session (`loaded`) are always shown.
// SHOW_AT: one eval (25 tools, 24 requests): the right tool always scored highest, but one at 0.24; wrong
// tools reached 0.22 on requests no tool fits. The shortlist only has to keep the right tool in: System One's pick, the 0.95
// bar and the yes/no confirmation stop wrong ones. ponytail: from one eval; revise as libraries grow.
export const SHOW = 5
export const SHOW_AT = 0.2

export const shortlist = (one: SystemOne["Service"], goal: string, entries: ReadonlyArray<Entry>, loaded: ReadonlySet<string>) =>
  Effect.gen(function* () {
    if (entries.length <= SHOW) return { shown: entries, scores: {} as Record<string, number>, tokens: { input: 0, output: 0 } }

    const questions = Object.fromEntries(entries.map((e) => [e.name, { question: `Would this tool answer the goal? The tool: ${e.description}`, yes: "Running this tool on the goal would do what the goal asks", no: "It's for something else, or only part of it" }]))
    const { answers, tokens } = yield* one.judge({ goal }, questions)

    const best = entries.filter((e) => (answers[e.name] ?? 0) >= SHOW_AT).sort((a, b) => answers[b.name]! - answers[a.name]!).slice(0, SHOW)
    const shown = [...best, ...entries.filter((e) => loaded.has(e.name) && !best.includes(e))]
    return { shown, scores: answers, tokens }
  })
