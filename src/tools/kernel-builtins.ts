import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { ALL, type Grants, has } from "../base/grants"
import { outsideCaller } from "../kernel/guard"
import { call, isPlainData, Sources } from "../kernel/runtime"
import { type Choice, verdictFor, withUnclear } from "./judge-rules"
import { TOOLS } from "./tools"
import { BASH_TIMEOUT_SECONDS, runBash } from "./bash"

// What every kernel cell can import from "kernel" in empty-vessel (besides Effect, call and result). Everything that touches
// the world is a service, so each Effect's requirements say what it touches: Files, Shell,
// System One, Agents, Library, Sources (tool sources), Time, Random. `layer` provides them all when a cell's action runs.
// Runs inside a cell's Worker: the services use Bun and the host directly (this file is empty-vessel's own code).

type Answers = Readonly<Record<string, { choice: string; confidence: number }>>
export type Question = { readonly question: string; readonly options: Readonly<Record<string, string>> }
export type JobView = { readonly status: "queued" | "running" | "done" | "failed" | "cancelled" | "unknown"; readonly answer?: string }

export type SkillArgs = { readonly name: string; readonly arguments?: string }

export class Files extends Context.Service<Files, {
  readonly read: (path: string, offset?: number, limit?: number) => Effect.Effect<string>
  readonly readText: (path: string) => Effect.Effect<string, Error>
  readonly skill: (args: SkillArgs) => Effect.Effect<string, Error>
  readonly write: (path: string, content: string) => Effect.Effect<string>
  readonly edit: (path: string, edits: ReadonlyArray<{ oldText: string; newText: string }>) => Effect.Effect<string>
}>()("empty-vessel/Files") {}
export class Shell extends Context.Service<Shell, { readonly run: (command: string, timeoutSeconds: number) => Effect.Effect<string> }>()("empty-vessel/Shell") {}
export class SystemOne extends Context.Service<SystemOne, {
  readonly ask: (evidence: unknown, questions: Readonly<Record<string, Question>>) => Effect.Effect<Answers, Error>
  readonly recheck: (evidence: string, questions: Readonly<Record<string, Choice>>) => Effect.Effect<Readonly<Record<string, string>>, Error>
}>()("empty-vessel/kernel/SystemOne") {}
export class Agents extends Context.Service<Agents, {
  readonly spawn: (task: string, options?: SpawnOptions) => Effect.Effect<string, Error>
  readonly wait: (ids: ReadonlyArray<string>, seconds: number) => Effect.Effect<Readonly<Record<string, JobView>>, Error>
  readonly cancel: (id: string) => Effect.Effect<string, Error>
  readonly jobs: Effect.Effect<Readonly<Record<string, { task: string; status: string }>>, Error>
}>()("empty-vessel/Agents") {}
export class Library extends Context.Service<Library, {
  readonly promote: (args: { name: string; description: string; example: string; for: "systemOne" | "systemTwo"; parameters?: Readonly<Record<string, string>> }) => Effect.Effect<string, Error>
  readonly tools: Effect.Effect<Readonly<Record<string, string>>, Error>
  readonly handTools: (names: ReadonlyArray<string>) => Effect.Effect<string, Error>
  readonly memory: (change: MemoryChange) => Effect.Effect<string, Error>
}>()("empty-vessel/Library") {}
type MemoryScope = "agent" | "project"
type MemoryChange = { readonly action: "add" | "replace" | "remove"; readonly scope: MemoryScope; readonly text?: string; readonly old?: string }
export class Time extends Context.Service<Time, { readonly now: Effect.Effect<number> }>()("empty-vessel/Time") {}
export class Random extends Context.Service<Random, { readonly next: Effect.Effect<number> }>()("empty-vessel/Random") {}
export { Sources }

const tool = (name: string, args: object) => TOOLS.find((t) => t.name === name)!.call(args)
const readOnly = (what: string) => Effect.succeed(`not done: files are read-only in this kernel (${what})`)

// The services, only those `g` grants (config.json's kernel.tools): one it doesn't isn't provided at all, so even a cell
// that names it some other way (its key) gets nothing. Read-only files: write and edit say so instead of writing.
export const layerFor = (g: Grants) => Layer.mergeAll(
  Layer.succeed(Time, Time.of({ now: Effect.sync(() => Date.now()) })),
  Layer.succeed(Random, Random.of({ next: Effect.sync(() => Math.random()) })),
  ...(has(g, "read") ? [Layer.succeed(Files, Files.of({
    read: (path, offset, limit) => tool("read", { path, ...(offset ? { offset } : {}), ...(limit ? { limit } : {}) }),
    skill: (args) => call("skill", args) as Effect.Effect<string, Error>,
    readText: (path) => Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (e) => new Error(`can't read ${path}: ${e}`) }),
    write: (path, content) => (has(g, "write") ? tool("write", { path, content }) : readOnly(`write ${path}`)),
    edit: (path, edits) => (has(g, "write") ? tool("edit", { path, edits }) : readOnly(`edit ${path}`)),
  }))] : []),
  // Always ask the host. A cell replacing local Effect services cannot authorize its own command.
  ...(g.shell ? [Layer.succeed(Shell, Shell.of({ run: (command, timeout) =>
    runBash(command, (timeout ?? BASH_TIMEOUT_SECONDS) * 1000, (action) => call("$actionGuard", action)),
  }))] : []),
  ...(g.systemOne ? [Layer.succeed(SystemOne, SystemOne.of({
    ask: (evidence, questions) => call("systemOne", { evidence, questions }) as Effect.Effect<Answers, Error>,
    recheck: (evidence, questions) => call("recheck", { evidence, questions }) as Effect.Effect<Readonly<Record<string, string>>, Error>,
  }))] : []),
  ...(g.agents ? [Layer.succeed(Agents, Agents.of({
    spawn: (task, options) => call("spawn", options?.tools || options?.agent ? { task, ...options } : task) as Effect.Effect<string, Error>,
    wait: (ids, seconds) => call("wait", { ids, seconds }) as Effect.Effect<Readonly<Record<string, JobView>>, Error>,
    cancel: (id) => call("cancel", id) as Effect.Effect<string, Error>,
    jobs: call("jobs") as Effect.Effect<Readonly<Record<string, { task: string; status: string }>>, Error>,
  }))] : []),
  ...(g.library ? [Layer.succeed(Library, Library.of({
    promote: (args) => call("promote", args) as Effect.Effect<string, Error>,
    tools: call("tools") as Effect.Effect<Readonly<Record<string, string>>, Error>,
    handTools: (names) => call("handTools", names) as Effect.Effect<string, Error>,
    memory: (change) => call("memory", change) as Effect.Effect<string, Error>,
  }))] : []),
) as Layer.Layer<Files | Shell | SystemOne | Agents | Library | Time | Random> // only what's granted, in fact: cells see the rest missing
export const layer = layerFor(ALL)

// A file's text with line numbers (2,000 lines at a time: offset/limit for more). readText: the raw text.
export const read = (path: string, offset?: number, limit?: number) => Files.use((f) => f.read(path, offset, limit))
// Load instructions, not executable code. Files capability keeps remember and grants honest.
export const skill = (args: SkillArgs) => Files.use((f) => f.skill(args))
export const readText = (path: string) => Files.use((f) => f.readText(path))
export const write = (path: string, content: string) => Files.use((f) => f.write(path, content))
export const edit = (path: string, edits: ReadonlyArray<{ oldText: string; newText: string }>) => Files.use((f) => f.edit(path, edits))
// A shell command in the project folder: "exit N" and its output (the end of it, if long).
export const bash = (command: string, timeoutSeconds = BASH_TIMEOUT_SECONDS) => Shell.use((s) => s.run(command, timeoutSeconds))
// The time (milliseconds since 1970) and a random number in [0, 1): through services, so they show in requirements.
export const now = () => Time.use((t) => t.now)
export const random = () => Random.use((r) => r.next)

// System One (a fast judgment model): named questions about some evidence, all answered in one call; each answer
// is one of its options with a confidence. For many items, call it per item (Effect.forEach, { concurrency: 8 }).
export const systemOne = (evidence: unknown, questions: Readonly<Record<string, Question>>) => SystemOne.use((j) => j.ask(evidence, questions))

// Sub-agents (full empty-vessel turns with their own context and kernel) run as jobs, without blocking: spawn returns the job's
// id at once (at most 4 run at a time; more are queued); keep working and collect answers with wait. For work that needs
// its own reasoning (reading code, writing). To classify, match or rate items, use judge. `tools` narrows what the
// sub-agent's kernel grants (e.g. { shell: false, files: "read-only" }); never more than this one's. `agent` runs it as a
// named agent (~/.empty-vessel/agents/<name>/agent.md): its instructions, its System Two, its grants (narrowed the same way).
export type SpawnOptions = { readonly tools?: Partial<Grants>; readonly agent?: string }
export const spawn = (task: string, options?: SpawnOptions) => Agents.use((a) => a.spawn(task, options))
// Up to `seconds` (default 300) for these jobs; each comes back done (with its answer), failed, cancelled or still
// running (then wait again). A run can't finish while jobs are uncollected.
export const wait = (ids: string | ReadonlyArray<string>, seconds = 300) => Agents.use((a) => a.wait(typeof ids === "string" ? [ids] : ids, seconds))
export const cancel = (id: string) => Agents.use((a) => a.cancel(id))
export const jobs = () => Agents.use((a) => a.jobs)

// promote: make one of your definitions (from an earlier cell) an option System One can pick in later turns, so requests like
// `example` are handled without you. It must be self-contained (one cell, only Effect and the built-ins), take the goal
// (a string), nothing, or `parameters`, and run on `example` (it's run once as the check). `description` is all System One reads to pick it:
// say what it answers and which close requests it doesn't (e.g. "this package's version, not a dependency's"); System One
// grades it against a rubric, and a weak one comes back to rewrite.
// `forWho`: "systemOne" (default: a tool that answers a request; `example` is a request) or "systemTwo" (a helper you call
// with your own arguments; `example` is a call, e.g. 'grepSource("TODO")'). New tools start on trial in a pool.
// `parameters` (System One tools): what varies between requests, name → what it is ({ customer: "the customer's id" }); the
// tool takes them as one object of strings, filled from each request by a small model, however it's worded.
export const promote = (name: string, description: string, example: string, forWho: "systemOne" | "systemTwo" = "systemOne", parameters?: Readonly<Record<string, string>>) =>
  Library.use((l) => l.promote({ name, description, example, for: forWho, ...(parameters ? { parameters } : {}) }))
// The shared library: every promoted tool and what it's for. Any of them can be imported from "kernel" like a built-in.
export const tools = () => Library.use((l) => l.tools)
// Hand library tools to System One: they're in its options from now on this session, even if its shortlist (the few
// tools it judges relevant to a request) would leave them out. For when you see a tool that fits work System One hands you.
export const handTools = (names: ReadonlyArray<string>) => Library.use((l) => l.handTools(names))
// memory: what a later session would need (for this project; or for the agent: the user, this computer), kept across sessions
// and given to System Two at the start of each. One short line per entry; each scope has a size limit. The answer says
// what was done, or why not (full: merge or remove first; no or several entries containing `old`).
export const memory = {
  add: (scope: MemoryScope, text: string) => Library.use((l) => l.memory({ action: "add", scope, text })),
  replace: (scope: MemoryScope, old: string, text: string) => Library.use((l) => l.memory({ action: "replace", scope, old, text })),
  remove: (scope: MemoryScope, old: string) => Library.use((l) => l.memory({ action: "remove", scope, old })),
}

// remember: an expensive Effect (or a function returning one) whose result is saved, so it runs once (per input, for a
// function) across every later cell: `export const labels = remember(systemOne(…))`. Only for what can't change underneath:
// the type allows System One, sub-agents, the library and tool sources, not Files, Shell, Time or Random (a file read or a
// command must run again). Results must be JSON. forget(labels) drops what was saved.
// The key: a hash of the defining file's code (a cell, a library tool; the scope file it imports from doesn't count,
// so the same code run again as a new cell finds what was saved, and changed code starts fresh), and which remember
// it is in that file (the top level only defines things, so the order is the same every time the file loads).
type Rememberable = SystemOne | Agents | Library | Sources
const KEY = Symbol.for("empty-vessel.remember")
const counts = new Map<string, number>()
const savedIn = () => join(process.env.KERNEL_DIR ?? tmpdir(), "remembered")

const slot = () => {
  const file = outsideCaller() ?? "unknown"
  const index = (counts.get(file) ?? 0) + 1
  counts.set(file, index)
  const code = existsSync(file) ? readFileSync(file, "utf8").replace(/(["'])\.\/scope(-\d+)?\.ts\1/g, `"kernel"`) : file
  return `${Bun.hash(code).toString(36)}-${index}`
}

const kept = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const file = join(savedIn(), `${key}.json`)
    if (existsSync(file)) return Effect.succeed(JSON.parse(readFileSync(file, "utf8")) as A)
    return effect.pipe(Effect.tap((value) => Effect.sync(() => {
      if (!isPlainData(value)) throw new Error("remember keeps JSON only (plain objects, arrays, strings, numbers, booleans, null): return JSON from what you remember")
      mkdirSync(savedIn(), { recursive: true })
      writeFileSync(file, JSON.stringify(value))
    })))
  })

export function remember<A, E, R extends Rememberable>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
export function remember<Args extends ReadonlyArray<unknown>, A, E, R extends Rememberable>(f: (...args: Args) => Effect.Effect<A, E, R>): (...args: Args) => Effect.Effect<A, E, R>
export function remember(what: any): any {
  const key = slot()
  const made = Effect.isEffect(what) ? kept(key, what) : (...args: Array<unknown>) => kept(`${key}-${Bun.hash(JSON.stringify(args)).toString(36)}`, what(...args))
  Object.defineProperty(made, KEY, { value: key })
  return made
}
export const forget = (remembered: unknown) =>
  Effect.sync(() => {
    const key = (remembered as { [KEY]?: string })?.[KEY]
    if (!key || !existsSync(savedIn())) return 0
    const gone = readdirSync(savedIn()).filter((f) => f === `${key}.json` || f.startsWith(`${key}-`))
    for (const f of gone) rmSync(join(savedIn(), f))
    return gone.length
  })

// judge: have System One answer the same questions about many items. For each item, `evidence` gives the text System One reads (from
// a definition, e.g. showPair); System One answers all the questions in one call; answers it can't tell, or low-confidence
// yes/no ones, are re-checked by one direct model call with the same evidence. 8 items at a time. The results are final: use them
// as they are. Returned (and stored as $N): every item with its answers, e.g.
// [{ item: "test-007", answers: { match: { answer: "no", confidence: 0.97, by: "systemOne" } } }, …]
// systemOneFailed: System One's call failed for this item (every answer then came from the re-check), so an outage shows.
export type Judged<T> = { readonly item: T; readonly answers: Readonly<Record<string, { answer: string; confidence: number; by: "systemOne" | "llm" }>>; readonly systemOneFailed?: true }
const EVIDENCE_MAX = 30_000 // characters System One reads per item (it takes ~32k tokens with the questions)

// `R`: what an evidence Effect needs (a file read: Files), so judge's type says so too; plain text needs nothing.
export const judge = <T, E = never, R = never>(
  items: ReadonlyArray<T>,
  evidence: (item: T) => Effect.Effect<unknown, E, R> | Promise<unknown> | string | object | number | boolean | null | undefined,
  questions: Readonly<Record<string, Choice>>,
) =>
  Effect.forEach(items, (item) =>
    Effect.gen(function* () {
      const got = evidence(item)
      const value = Effect.isEffect(got) ? yield* (got as Effect.Effect<unknown, E, R>) : yield* Effect.promise(async () => got)
      const text = (typeof value === "string" ? value : JSON.stringify(value, null, 1)).slice(0, EVIDENCE_MAX)

      const picks = yield* systemOne(text, withUnclear(questions))
      const answers: Record<string, { answer: string; confidence: number; by: "systemOne" | "llm" }> = {}
      for (const [k, q] of Object.entries(questions)) {
        const p = picks[k] ?? { choice: "", confidence: 0 }
        answers[k] = { answer: verdictFor(p.choice, p.confidence, q.options), confidence: p.confidence, by: "systemOne" }
      }

      const open = Object.keys(answers).filter((k) => answers[k]!.answer === "unsure")
      if (open.length) {
        const rechecked = yield* SystemOne.use((j) => j.recheck(text, Object.fromEntries(open.map((k) => [k, questions[k]!]))))
        for (const k of open) answers[k] = { answer: rechecked[k] ?? "unsure", confidence: answers[k]!.confidence, by: "llm" }
      }

      const failed = Object.values(picks).every((p) => !p.choice && p.confidence === 0)
      const judged: Judged<T> = { item, answers, ...(failed ? { systemOneFailed: true as const } : {}) }
      return judged
    }), { concurrency: 8 })
