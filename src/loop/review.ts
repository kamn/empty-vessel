import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { exitOf, lessonIn } from "../base/lessons"
import { Memory } from "../base/memory"
import { projectDir } from "../base/project"
import { SESSIONS } from "../base/session"
import { Store } from "../base/store"
import { Reviewer } from "../learning/reviewer"

// empty-vessel review: a look back over this project's recent sessions, from what the session files recorded, so real use
// turns into findings without reading sessions by hand. Code finds the signals (long silences, timeouts and reruns,
// files read again and again, scope notes, the user steering or stopping it, checks failing over and over, errors,
// very long turns) and the user's /flags; one structured question to System Two's model writes them up in two
// buckets: what to fix in empty-vessel, and notes for this repo. Notes are only proposals: `review save` puts them in the
// project's memory (the Memory service), nothing else does. Every review is logged in <project>/review.jsonl, so the
// next one starts where it left off.

type Line = Readonly<{ role: string; text: string; ts: number; args?: { code?: string; message?: string }; output?: string; verdict?: string; running?: boolean; activity?: string }>
export type Signal = Readonly<{ kind: string; session: string; turn: number; at: number; text: string }>
export type Flag = Readonly<{ session: string; turn: number; at: number; note: string; running: boolean; before: ReadonlyArray<string> }>

const SILENCE_MS = 5 * 60_000 // as long as the progress reminder's default (systemTwo.progressMinutes)
const LONG_TURN_MS = 10 * 60_000, MANY_COMMANDS = 25 // ponytail: fixed thresholds; outliers against the project's own turns when there's history
const READS = /\b(?:read|readText)\(\s*["'`]([^"'`]+)["'`]|\bcat\s+([\w./-]+)/g
const WRITES = /\b(?:write|edit)\(\s*["'`]([^"'`]+)["'`]/g
const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ")
const what = (l: Line) => (l.role === "check" ? `check ${l.text} → ${l.verdict}` : l.text === "kernel" ? `cell: ${short(l.args?.code ?? "")}` : `${l.text}: ${short(l.args?.message ?? JSON.stringify(l.args ?? {}))}`)

// One session's records into signals, flags, and pairs of a command that failed then a changed one that worked (a
// candidate lesson: an env var, PATH or version the repo needs).
export const signalsOf = (session: string, lines: ReadonlyArray<Line>) => {
  const signals: Array<Signal> = [], flags: Array<Flag> = [], fixes: Array<string> = []
  const say = (kind: string, turn: number, at: number, text: string) => signals.push({ kind, session, turn, at, text })
  let turn = 0, started = 0, shown = 0, commands = 0, failedChecks = 0, errors = 0
  let reads = new Map<string, number>(), timedOut = new Set<string>(), failed: Array<string> = []
  const recent: Array<string> = []

  for (const l of lines) {
    const at = l.ts - started
    if (l.role === "user") {
      turn++; started = shown = l.ts; commands = failedChecks = errors = 0
      reads = new Map(); timedOut = new Set(); failed = []; recent.length = 0
      continue
    }
    if (!turn) continue

    // Anything shown to the user (a note, the answer) ends a silence; a long one is a signal.
    const told = l.role === "assistant" || (l.role === "command" && l.text === "tell_user")
    if (told && l.ts - shown > SILENCE_MS) say("silence", turn, at, `${Math.round((l.ts - shown) / 60_000)} min without telling the user anything`)
    if (told) shown = l.ts

    if (l.role === "command" && l.text === "kernel") {
      const code = l.args?.code ?? ""
      commands++
      if (timedOut.has(code)) say("rerun", turn, at, `reran a cell that had timed out, unchanged: ${short(code)}`)
      if (/timed out after/.test(l.output ?? "")) { timedOut.add(code); say("timeout", turn, at, `a command timed out: ${short(code)}`) }
      if (/^cell \d+: (error|type-error|refused|timeout)/.test(l.output ?? "")) errors++

      for (const m of code.matchAll(WRITES)) reads.delete(m[1]!)
      for (const m of code.matchAll(READS)) {
        const path = m[1] ?? m[2]!
        reads.set(path, (reads.get(path) ?? 0) + 1)
        if (reads.get(path) === 3) say("reread", turn, at, `read ${path} 3 times without changing it`)
      }

      // A failing command, then a later one that worked with an env var, PATH or version added: a lesson for the repo.
      const env = lessonIn(failed, code, l.output ?? "")
      if (env.length) fixes.push(`failed: ${short(failed.at(-1)!, 200)}\n  then worked with ${env.join(" ")}: ${short(code, 200)}`)
      if (exitOf(l.output) !== 0) failed.push(code)
    }

    if (l.role === "check" && l.verdict !== "passed" && ++failedChecks === 2) say("checks", turn, at, `the check failed again: ${short(l.text)}`)
    if (l.role === "scope") say("scope", turn, at, short(l.text, 200))
    if (l.role === "steer") say("steer", turn, at, `the user redirected it mid-run: ${short(l.text)}`)
    if (l.role === "actions" && l.text === "stopped by the user") say("stop", turn, at, "the user stopped it")
    if (l.role === "flag") flags.push({ session, turn, at, note: l.text, running: l.running ?? false, before: [...recent] })
    if (l.role === "command" || l.role === "check") { recent.push(what(l)); if (recent.length > 3) recent.shift() }

    if (l.role === "assistant") {
      if (errors >= 3) say("errors", turn, at, `${errors} cells failed in this turn`)
      if (l.ts - started > LONG_TURN_MS || commands > MANY_COMMANDS) say("long", turn, at, `a long turn: ${Math.round((l.ts - started) / 60_000)} min, ${commands} cells`)
    }
  }

  return { signals, flags, fixes }
}

// This project's root sessions to review: the ones named (by id or its end), else those with anything after `since`,
// else (no review yet) the last few.
const sessionsFor = (root: string, ids: ReadonlyArray<string>, since: number, latest = 5) =>
  Effect.gen(function* () {
    const store = yield* Store
    const project = projectDir(root)
    const found: Array<{ id: string; lines: ReadonlyArray<Line> }> = []

    for (const id of yield* store.list(SESSIONS)) {
      const lines: Array<Line> = ((yield* store.get(`${SESSIONS}/${id}/main.jsonl`)) ?? "").split("\n").flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
      const first = lines[0] as (Line & { checks?: string }) | undefined
      if (first?.role !== "project" || (first.checks ?? projectDir(first.text)) !== project) continue
      if (ids.length ? ids.some((wanted) => id.endsWith(wanted)) : since ? (lines.at(-1)?.ts ?? 0) > since : true) found.push({ id, lines })
    }

    return ids.length || since ? found : found.slice(-latest)
  })

// The review log: each review (what it proposed) and each save.
type LogLine = Readonly<{ kind: "review"; at: number; sessions: ReadonlyArray<string>; signals: number; flags: number; notes: ReadonlyArray<string> }> | Readonly<{ kind: "saved"; at: number; notes: ReadonlyArray<string> }>
const logFile = (root: string) => join(projectDir(root), "review.jsonl")
const readLog = (root: string): ReadonlyArray<LogLine> =>
  existsSync(logFile(root)) ? readFileSync(logFile(root), "utf8").split("\n").flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } }) : []
const append = (root: string, line: LogLine) => { mkdirSync(projectDir(root), { recursive: true }); appendFileSync(logFile(root), `${JSON.stringify(line)}\n`) }

const Findings = Schema.Struct({
  summary: Schema.String,
  fixInEmptyVessel: Schema.Array(Schema.Struct({ finding: Schema.String, where: Schema.String })),
  notesForRepo: Schema.Array(Schema.Struct({ note: Schema.String, why: Schema.String })),
})
const INSTRUCTIONS = [
  "You review sessions of empty-vessel, a coding agent, for the user who ran them. You get the user's flags (moments they marked as wrong, with what the agent did just before), signals empty-vessel's code found, and commands that failed and then worked with something changed.",
  "Write findings in two buckets. fixInEmptyVessel: problems in how the agent worked that a change to empty-vessel itself would prevent (it went quiet, reran a command that timed out, reread files, changed more than was asked, failed the same check again and again). One finding each, plainly, saying what happened and what empty-vessel should do differently; `where` names the session and turn. The user's flags come first: explain each one.",
  "notesForRepo: what a new teammate would want to know about this repo, learned the hard way in these sessions (a version, env var or PATH a script needs, how tests are run, a setup step only the user can do). Only what would help a different task in this repo, one line each, with the command or value; `why` says what it cost. Empty when there's nothing.",
  "summary: one or two sentences. Don't invent problems the evidence doesn't show.",
].join("\n")

const report = (sessions: number, signals: ReadonlyArray<Signal>, flags: ReadonlyArray<Flag>) => [
  ...flags.map((f) => `flag (session …${f.session.slice(-8)}, turn ${f.turn}, ${Math.round(f.at / 1000)} s in${f.running ? ", while it worked" : ""}): ${f.note || "(no note)"}${f.before.length ? `\n  just before: ${f.before.join(" · ")}` : ""}`),
  ...signals.map((s) => `${s.kind} (session …${s.session.slice(-8)}, turn ${s.turn}, ${Math.round(s.at / 1000)} s in): ${s.text}`),
].join("\n") || `nothing found in ${sessions} session${sessions === 1 ? "" : "s"}`

// empty-vessel review [session ids…]: the review. Prints the findings, and the notes it proposes (numbered, for `review save`).
export const review = (root: string, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const started = Date.now()
    const since = ids.length ? 0 : readLog(root).filter((l) => l.kind === "review").at(-1)?.at ?? 0
    const sessions = yield* sessionsFor(root, ids, since)
    if (!sessions.length) return [since ? `no sessions since the last review (${new Date(since).toLocaleString()})` : "no sessions in this project yet"]

    const found = sessions.map((s) => signalsOf(s.id, s.lines))
    const signals = found.flatMap((f) => f.signals), flags = found.flatMap((f) => f.flags), fixes = found.flatMap((f) => f.fixes)
    const turns = sessions.flatMap((s) => s.lines.filter((l) => l.role === "user").map((l) => `- …${s.id.slice(-8)}: ${short(l.text, 200)}`))
    const evidence = [`Sessions reviewed (${sessions.length}), their requests:\n${turns.join("\n")}`, `Flags and signals:\n${report(sessions.length, signals, flags)}`,
      `Commands that failed, then worked with something added:\n${fixes.join("\n") || "none"}`].join("\n\n")

    // One question to System Two's model writes it up; with no model (the fake), the signals alone.
    const asked = yield* (yield* Reviewer).ask(INSTRUCTIONS, Findings, evidence).pipe(Effect.option)
    const value = asked._tag === "Some" ? asked.value.value : undefined
    const cost = asked._tag === "Some" ? `${((Date.now() - started) / 1000).toFixed(1)} s · ${asked.value.tokens.input - (asked.value.tokens.cached ?? 0)} fresh tokens in, ${asked.value.tokens.output} out` : "no model: signals only"
    const notes = value?.notesForRepo.map((n) => n.note) ?? []
    append(root, { kind: "review", at: Date.now(), sessions: sessions.map((s) => s.id), signals: signals.length, flags: flags.length, notes })

    return [
      `review of ${sessions.length} session${sessions.length === 1 ? "" : "s"}${since ? ` since ${new Date(since).toLocaleString()}` : ""}${value ? `: ${value.summary}` : ""}`,
      "", "What happened (flags first):", ...report(sessions.length, signals, flags).split("\n").map((l) => `  ${l}`),
      ...(value ? ["", "Fix in empty-vessel:", ...(value.fixInEmptyVessel.length ? value.fixInEmptyVessel.map((f) => `  - ${f.finding} (${f.where})`) : ["  nothing"])] : []),
      ...(value ? ["", "Notes for this repo (proposed; `review save` keeps them, `review save 2` just one):", ...(notes.length ? value.notesForRepo.map((n, i) => `  ${i + 1}. ${n.note}  (${n.why})`) : ["  none"])] : []),
      "", `cost: ${cost}`,
    ]
  })

// review save [n…]: the last review's proposed notes (all, or the numbered ones) into the project's memory.
export const saveNotes = (root: string, picked: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const last = readLog(root).filter((l) => l.kind === "review").at(-1)
    if (!last?.notes.length) return ["the last review proposed no notes"]

    const chosen = picked.length ? picked.flatMap((n) => (last.notes[n - 1] ? [last.notes[n - 1]!] : [])) : last.notes
    if (!chosen.length) return ["no note by that number"]

    // Each note, if the project's memory has room (it has a limit: memory.ts); one that doesn't fit is said, with what
    // to do, and the rest still go in.
    const memory = yield* Memory
    const saved: Array<string> = [], full: Array<string> = []
    for (const note of chosen) {
      const refused = yield* memory.add("project", note).pipe(Effect.as(undefined), Effect.catch((e) => Effect.succeed(e.message)))
      if (refused) full.push(`  - ${note} (${refused})`)
      else saved.push(note)
    }

    if (saved.length) append(root, { kind: "saved", at: Date.now(), notes: saved })
    return [
      ...(saved.length ? [`saved to this project's memory:`, ...saved.map((n) => `  - ${n}`)] : []),
      ...(full.length ? ["not saved, the project's memory is full:", ...full, `  merge or remove entries in ${join(projectDir(root), "learned.md")} (or ask empty-vessel to merge its project notes), then review save again`] : []),
    ]
  })

// `/review [save [n…] | session ids…]` and `empty-vessel review …`: one answer as text.
export const reviewCommand = (args: string, root = process.cwd()) => {
  const [first, ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const run: Effect.Effect<ReadonlyArray<string>, never, Memory | Reviewer | Store> =
    first === "save" ? saveNotes(root, rest.map(Number).filter(Number.isInteger)) : review(root, [first, ...rest].filter((a): a is string => !!a))
  return run.pipe(Effect.map((lines) => lines.join("\n")))
}
