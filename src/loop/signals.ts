import { Effect } from "effect"
import { exitOf, lessonIn } from "../base/lessons"
import { projectDir } from "../base/project"
import { SESSIONS } from "../base/session"
import { Store } from "../base/store"

// What refine (src/loop/refine.ts) reads back from this project's sessions: the records, and the signals code finds in
// them (long silences, timeouts and reruns, files read again and again, scope notes, the user steering or stopping it,
// checks failing over and over, errors, very long turns), the user's /flags with what happened just before, and
// commands that failed then worked with an env var, PATH or version added (a lesson for the repo).

export type Line = Readonly<{ role: string; text: string; ts: number; args?: { code?: string; text?: string; message?: string }; output?: string; verdict?: string; running?: boolean; activity?: string; checks?: string }>
export type Signal = Readonly<{ kind: string; session: string; turn: number; at: number; text: string }>
export type Flag = Readonly<{ session: string; turn: number; at: number; note: string; running: boolean; before: ReadonlyArray<string> }>

const SILENCE_MS = 5 * 60_000 // as long as the progress reminder's default (systemTwo.progressMinutes)
const LONG_TURN_MS = 10 * 60_000, MANY_COMMANDS = 25 // ponytail: fixed thresholds; outliers against the project's own turns when there's history
const READS = /\b(?:read|readText)\(\s*["'`]([^"'`]+)["'`]|\bcat\s+([\w./-]+)/g
const WRITES = /\b(?:write|edit)\(\s*["'`]([^"'`]+)["'`]/g
export const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ")
const what = (l: Line) => (l.role === "check" ? `check ${l.text} → ${l.verdict}` : l.text === "kernel" ? `cell: ${short(l.args?.code ?? "")}` : `${l.text}: ${short(l.args?.message ?? JSON.stringify(l.args ?? {}))}`)

// One session's records into signals, flags, and pairs of a command that failed then a changed one that worked.
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

// This project's root sessions with anything after `since` (ms since 1970), oldest first; with no `since` (never
// refined), the last few. A sub-agent's sessions are part of its parent's work.
export const sessionsSince = (root: string, since: number, latest = 5) =>
  Effect.gen(function* () {
    const store = yield* Store
    const project = projectDir(root)
    const found: Array<{ id: string; lines: ReadonlyArray<Line> }> = []

    for (const id of yield* store.list(SESSIONS)) {
      const lines: Array<Line> = ((yield* store.get(`${SESSIONS}/${id}/main.jsonl`)) ?? "").split("\n").flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
      if (lines[0]?.role !== "project" || (lines[0].checks ?? projectDir(lines[0].text)) !== project) continue
      if (!since || (lines.at(-1)?.ts ?? 0) > since) found.push({ id, lines })
    }

    return since ? found : found.slice(-latest)
  })

// The flags, then the signals, one line each, as refine prints them.
export const report = (signals: ReadonlyArray<Signal>, flags: ReadonlyArray<Flag>) => [
  ...flags.map((f) => `flag (session …${f.session.slice(-8)}, turn ${f.turn}, ${Math.round(f.at / 1000)} s in${f.running ? ", while it worked" : ""}): ${f.note || "(no note)"}${f.before.length ? `\n  just before: ${f.before.join(" · ")}` : ""}`),
  ...signals.map((s) => `${s.kind} (session …${s.session.slice(-8)}, turn ${s.turn}, ${Math.round(s.at / 1000)} s in): ${s.text}`),
]
