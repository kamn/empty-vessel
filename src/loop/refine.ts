import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { Config } from "../base/config"
import { Memory, type Scope } from "../base/memory"
import { projectDir } from "../base/project"
import { makeSession } from "../base/session"
import { Usage } from "../base/usage"
import { removeCheck } from "../learning/checks"
import { Reviewer } from "../learning/reviewer"
import { SystemOne } from "../system-one/systemone"
import { SystemTwo } from "../system-two/systemtwo"
import { AskUser } from "../ui/ask"
import { Answer, instructions as adoptionInstructions, proposeTools } from "./adopt"
import { makeHost } from "./kernel"
import { libraryDir, loadLibrary, loadPool, updateTools } from "./library"
import { type Line, report, sessionsSince, short, signalsOf } from "./signals"
import { type Ctx, type Needs, newConversation, timed } from "./turnkit"

// Refine (Prime Agent's /refine): one look back over this project's sessions since the
// last refine, paid for only when asked. The user's /flags come first, with what happened just before them; then the
// signals code finds (src/loop/signals.ts); then one batch to System Two's model that proposes three kinds of thing:
// fixes for empty-vessel itself (reported, nothing applied), notes for memory (this project, or the agent), and tools (onto
// the trial pool through promote, so they still prove themselves). Notes and tools are applied only with the user's OK
// (a question, or --yes). Every refine and every edit is logged with an id (<project>/refine.jsonl); `refine log` lists
// them, `refine undo <id>` takes one back. Base instructions are never edited, and refine doesn't judge tools on trial:
// the reward stays what config.adoption.reward says (a self-improving harness amplifies whatever its reward rewards).

// A turn as its session tells it: the request, what System Two ran (cells' code, commands) and how it went, the answer.
type Turn = { readonly session: string; readonly n: number; readonly goal: string; readonly work: ReadonlyArray<string>; readonly answer: string }
const shown = (r: Line) => (r.text === "kernel" ? r.args?.code ?? r.args?.text ?? "" : `${r.text} ${JSON.stringify(r.args ?? {})}`)
const turnsOf = (session: string, lines: ReadonlyArray<Line>, since: number) => {
  const turns: Array<Turn> = []
  let open: { goal: string; work: Array<string> } | undefined, n = 0

  for (const r of lines) {
    if (r.role === "user") { open = { goal: r.text, work: [] }; n++ }
    else if (open && r.role === "command") open.work.push(`${shown(r).slice(0, 2500)}\n  → ${String(r.output ?? "").slice(-300)}`)
    else if (open && r.role === "check") open.work.push(`check ${r.text} → ${r.verdict}`)
    else if (open && r.role === "assistant") { if (r.ts > since) turns.push({ session, n, goal: open.goal, work: open.work, answer: r.text }); open = undefined }
  }

  return turns
}

// The batch, newest turns kept when there are too many. ponytail: a fixed cap of 60k characters; split into several
// asks if refining after long stretches of work loses too much.
const MAX_DIGEST = 60_000
const digestOf = (turns: ReadonlyArray<Turn>) => {
  const parts = turns.map((t, i) => [`## Turn ${i + 1} (session …${t.session.slice(-8)}, turn ${t.n})`, `Goal: ${t.goal}`,
    `What was run, in order (System Two's cells and commands → end of their output; checks → System One's verdict):\n${t.work.map((w) => `- ${w}`).join("\n") || "(nothing: answered from what it was given)"}`,
    `Answer: ${t.answer.slice(0, 1500)}`].join("\n"))
  const kept: Array<string> = []
  for (let size = 0, i = parts.length - 1; i >= 0 && size + parts[i]!.length <= MAX_DIGEST; size += parts[i]!.length, i--) kept.unshift(parts[i]!)
  return kept.join("\n\n")
}

// The log: one JSON line per event. A refine (what it found), each edit it proposed (applied or not), each undo.
export type Edit = Readonly<{ id: string; kind: "note" | "check" | "tool"; what: string; outcome: string; applied: boolean; trigger: string; file?: string; name?: string; text?: string; scope?: Scope; at: number }>
type Refined = Readonly<{ kind: "refine"; at: number; turns: number; sessions: ReadonlyArray<string>; cost: string; summary?: string; fixes?: ReadonlyArray<string>; flags?: number; signals?: number }>
type LogLine = Edit | Refined | Readonly<{ kind: "undo"; id: string; at: number }>
const logFile = (root: string) => join(projectDir(root), "refine.jsonl")
const readLines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } }) : [])
export const readLog = (root: string): ReadonlyArray<LogLine> => readLines(logFile(root))
const append = (root: string, line: LogLine) => { mkdirSync(projectDir(root), { recursive: true }); appendFileSync(logFile(root), `${JSON.stringify(line)}\n`) }
// Where the last look back ended: the last refine, or (from before the two were one command) the last review.
const lastAt = (root: string) => Math.max(0, ...readLog(root).filter((l) => l.kind === "refine").map((l) => (l as Refined).at),
  ...readLines(join(projectDir(root), "review.jsonl")).filter((l) => l.kind === "review").map((l) => l.at as number))

// What the model is asked for: a summary, fixes for empty-vessel, notes for memory. Tools come from adoption's own question.
const Findings = Schema.Struct({
  summary: Schema.String,
  fixInEmptyVessel: Schema.Array(Schema.Struct({ finding: Schema.String, where: Schema.String })),
  notes: Schema.Array(Schema.Struct({ text: Schema.String, scope: Schema.Literals(["project", "agent"]), why: Schema.String })),
})
const INSTRUCTIONS = [
  "You look back over sessions of empty-vessel, a coding agent, for the user who ran them. You get the user's flags (moments they marked as wrong, with what the agent did just before), signals empty-vessel's code found, commands that failed and then worked with something changed, the turns themselves, and what empty-vessel already remembers.",
  "fixInEmptyVessel: problems in how the agent worked that a change to empty-vessel itself would prevent (it went quiet, reran a command that timed out, reread files, changed more than was asked, failed the same check again and again). One finding each, plainly, saying what happened and what empty-vessel should do differently; `where` names the session and turn. The user's flags come first: explain each one. Don't invent problems the evidence doesn't show.",
  "notes: what a later session would need, learned the hard way here, one short line each with the command or value: scope project for anything about this repo (a version, env var or PATH a script needs, how tests are run, a setup step only the user can do, a convention), agent only for what holds in every project (the user's preferences, this computer). Only what would help a different task; nothing already remembered; `why` says what it cost. Empty when there's nothing.",
  "summary: one or two sentences.",
].join("\n")

// The user's pick: all, none, or the numbers they typed.
const picked = (answer: string, count: number) =>
  /^all\b/i.test(answer.trim()) ? Array.from({ length: count }, (_, i) => i + 1) : [...answer.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n >= 1 && n <= count)

// Refine: look back since the last refine, propose, and apply what the user accepts (all, with `yes`).
export const refine = (root = process.cwd(), yes = false) =>
  Effect.gen(function* () {
    const started = Date.now()
    const since = lastAt(root)
    const sessions = yield* sessionsSince(root, since)
    const turns = sessions.flatMap((s) => turnsOf(s.id, s.lines, since))
    const found = sessions.map((s) => signalsOf(s.id, s.lines))
    const signals = found.flatMap((f) => f.signals), flags = found.flatMap((f) => f.flags), fixes = found.flatMap((f) => f.fixes)
    if (!turns.length && !flags.length) return [`nothing new to refine from${since ? ` since the last refine (${new Date(since).toLocaleString()})` : " yet: no turns in this project"}`]

    // Its own session (not under sessions/: never one to resume or refine) and a turn context for the tools' checks.
    const session = yield* makeSession("refines")
    const config = yield* Config
    const ctx: Ctx = { session, input: "refine", depth: 0, conversation: newConversation(), config, systemOne: yield* SystemOne, systemTwo: yield* SystemTwo, usage: yield* Usage,
      spawn: () => Effect.succeed("sub-agents aren't available while refining") }
    const round = readLog(root).filter((l) => l.kind === "refine").length + 1
    const trigger = `${turns.length} turns in ${new Set(turns.map((t) => t.session)).size} sessions since ${since ? new Date(since).toISOString() : "the start"}`
    const digest = digestOf(turns)
    const happened = report(signals, flags)

    // One batch to System Two's model: the findings and notes, then the tools (adoption's question). With no model
    // (the fake), the signals alone.
    const evidence = [`Flags and signals:\n${happened.join("\n") || "none"}`, `Commands that failed, then worked with something added:\n${fixes.join("\n") || "none"}`,
      `Already remembered:\n${(yield* (yield* Memory).snapshot) || "nothing"}`, digest].join("\n\n")
    const asked = yield* timed(ctx, "systemTwo", (yield* Reviewer).ask(INSTRUCTIONS, Findings, evidence)).pipe(Effect.option)
    const findings = asked._tag === "Some" ? asked.value.result.value : undefined
    const dir = libraryDir(root)
    const tools = asked._tag === "None" ? [] : yield* Effect.gen(function* () {
      const ask = [`Tools on trial: (not judged by refine)`, `Tools already in the library: ${loadLibrary(dir).map((e) => e.name).join(", ") || "none"}`,
        `Tools already on trial in the pool: ${loadPool(dir).map((e) => e.name).join(", ") || "none"}`, digest].join("\n\n")
      const max = Math.max(config.adoption.maxProposals, 3) // a batch: room for more than one turn's worth
      const { result: { value } } = yield* timed(ctx, "systemTwo", (yield* Reviewer).ask(adoptionInstructions(max, config.adoption.proposals), Answer, ask))
      return [...value.proposals.filter((p) => p.for === "systemOne").slice(0, max), ...value.proposals.filter((p) => p.for === "systemTwo").slice(0, max)]
    }).pipe(Effect.orElseSucceed(() => []))

    // The proposals, numbered: notes, then tools. Applied only with the user's OK.
    const notes = findings?.notes ?? []
    const proposals = [...notes.map((n) => `note (${n.scope}): ${n.text}${n.why ? `  (${n.why})` : ""}`), ...tools.map((t) => `tool for ${t.for === "systemOne" ? "System One" : "System Two"}: ${t.name}: ${short(t.description, 160)}`)]
    const listed = proposals.map((p, i) => `  ${i + 1}. ${p}`)
    const chosen = !proposals.length ? [] : yes ? proposals.map((_, i) => i + 1)
      : picked((yield* (yield* AskUser).ask([{ question: `Refine proposes:\n${listed.join("\n")}\nKeep which? (numbers, like "1 3", or all)`, options: ["All of them", "None"] }]))[0]?.answer ?? "", proposals.length)

    const edits: Array<Edit> = []
    const edit = (kind: Edit["kind"], what: string, outcome: string, applied: boolean, extra: Partial<Edit> = {}) =>
      edits.push({ id: `${round}.${edits.length + 1}`, kind, what, outcome, applied, trigger, at: Date.now(), ...extra })

    // Notes into memory (it has limits: one that doesn't fit is said, with what to merge).
    const memory = yield* Memory
    for (const [i, n] of notes.entries()) {
      if (!chosen.includes(i + 1)) { edit("note", n.text, "not chosen", false, { text: n.text, scope: n.scope }); continue }
      const refused = yield* memory.add(n.scope, n.text).pipe(Effect.as(undefined), Effect.catch((e) => Effect.succeed(e.message)))
      edit("note", n.text, refused ?? `added (${n.scope})`, !refused, { text: n.text, scope: n.scope })
    }

    // Tools onto the trial pool, each checked by promote.
    const before = new Set([...loadLibrary(dir), ...loadPool(dir)].map((e) => e.name))
    const kept = tools.filter((_, i) => chosen.includes(notes.length + i + 1))
    const results = kept.length ? yield* proposeTools(dir, `refine ${round}`, makeHost(ctx, yield* Effect.context<Needs>()), kept) : []
    for (const t of tools) {
      const k = kept.indexOf(t)
      const said = k < 0 ? "not chosen" : results[k]!.slice(`${t.name} (${t.for}): `.length)
      const added = /^(added|promoted) /.test(said)
      edit("tool", `${t.name} (for ${t.for === "systemOne" ? "System One" : "System Two"})`, added ? (before.has(t.name) ? "on trial in the pool again (replacing the earlier one)" : "on trial in the pool") : said.slice(0, 300), added, { name: t.name })
    }

    // The log, then what it cost (paid now, not on every turn).
    const usage = yield* Usage
    yield* usage.add("turn", Date.now() - started, { input: 0, output: 0 })
    const { turn: spent } = yield* usage.take
    const fresh = (t: typeof spent.fill) => t.input - t.cached
    const cost = findings ? `${((Date.now() - started) / 1000).toFixed(1)}s · ${fresh(spent.systemTwo) + fresh(spent.systemOne) + fresh(spent.fill)} fresh tokens in (system 2 ${fresh(spent.systemTwo)}, system 1 ${fresh(spent.systemOne)}, fill ${fresh(spent.fill)})` : "no model: signals only"
    const fixLines = findings?.fixInEmptyVessel.map((f) => `${f.finding} (${f.where})`) ?? []
    for (const e of edits) append(root, e)
    append(root, { kind: "refine", at: started, turns: turns.length, sessions: sessions.map((s) => s.id), cost, summary: findings?.summary, fixes: fixLines, flags: flags.length, signals: signals.length })

    return [
      `refine ${round}: ${trigger}${findings ? `: ${findings.summary}` : ""}`,
      "", "What happened (flags first):", ...(happened.length ? happened.flatMap((l) => l.split("\n")).map((l) => `  ${l}`) : ["  nothing found"]),
      ...(findings ? ["", "Fix in empty-vessel:", ...(fixLines.length ? fixLines.map((f) => `  - ${f}`) : ["  nothing"])] : []),
      ...(edits.length ? ["", "Proposed (kept with your OK):", ...edits.map(line)] : []),
      "", `cost: ${cost}`,
    ]
  })

const line = (e: Edit) => `  ${e.id.padEnd(5)} ${e.kind.padEnd(5)} ${e.applied ? "✓" : "✗"} ${e.what.slice(0, 120)}${e.applied ? "" : `  (${e.outcome})`}`

// The log, newest refine last: what each found, then each edit with its id, and whether it was undone.
export const showLog = (root = process.cwd()) => {
  const log = readLog(root)
  const undone = new Set(log.flatMap((l) => (l.kind === "undo" ? [l.id] : [])))
  const lines = log.flatMap((l) =>
    l.kind === "refine" ? [`refine at ${new Date(l.at).toLocaleString()}: ${l.turns} turns · ${l.cost}${l.summary ? `\n  ${l.summary}` : ""}`, ...(l.fixes ?? []).map((f) => `  fix in empty-vessel: ${f}`)]
    : l.kind === "undo" ? [] : [`${line(l)}${undone.has(l.id) ? "  (undone)" : ""}`])
  return lines.length ? lines : ["no refines yet in this project: /refine (or empty-vessel refine) looks back over the sessions so far"]
}

// Undo one edit by id: the note's line, the check (older refines saved checks), or the tool (from the pool, or the
// library if it graduated since).
export const undo = (root: string, id: string) =>
  Effect.gen(function* () {
    const log = readLog(root)
    const e = log.find((l): l is Edit => l.kind !== "refine" && l.kind !== "undo" && l.id === id)
    if (!e) return `no edit ${id} (see /refine log)`
    if (log.some((l) => l.kind === "undo" && l.id === id)) return `${id} is already undone`
    if (!e.applied) return `${id} wasn't applied (${e.outcome}): nothing to undo`

    if (e.kind === "note" && e.text) {
      const failed = yield* (yield* Memory).remove(e.scope === "agent" ? "agent" : "project", e.text).pipe(Effect.as(undefined), Effect.catch((m) => Effect.succeed(m.message)))
      if (failed) return `couldn't undo ${id}: ${failed}`
    }
    if (e.kind === "check" && e.file && e.name) yield* removeCheck(e.file, e.name)
    if (e.kind === "tool" && e.name) yield* updateTools(libraryDir(root), (library, pool) => ({ library: library.filter((t) => t.name !== e.name), pool: pool.filter((t) => t.name !== e.name), result: undefined }))

    append(root, { kind: "undo", id, at: Date.now() })
    return `undid ${id}: ${e.kind} ${e.what.slice(0, 120)}`
  })

// `/refine [--yes]`, `/refine log`, `/refine undo <id>` (the TUI and the plain prompt), and `empty-vessel refine …`.
export const refineCommand = (args: string, root = process.cwd()) => {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const yes = words.includes("--yes")
  const [what, id] = words.filter((w) => w !== "--yes")
  if (what === "log") return Effect.succeed(showLog(root).join("\n"))
  if (what === "undo") return id ? undo(root, id) : Effect.succeed("which edit? /refine undo <id> (ids are in /refine log)")
  if (what) return Effect.succeed(`/refine [--yes], /refine log or /refine undo <id> (not "${what}")`)
  return refine(root, yes).pipe(Effect.map((lines) => lines.join("\n")), Effect.catch((e) => Effect.succeed(`refine failed: ${e instanceof Object && "message" in e ? String(e.message) : String(e)}`)))
}
