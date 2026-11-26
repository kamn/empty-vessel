import { statSync } from "node:fs"
import { Effect } from "effect"
import { add, type Graph, query, withRetry } from "empty-graph"
import { GraphMemory, projectOf } from "../base/graph-memory"
import { type LogEntry, logEntries, SESSIONS } from "../base/session"
import { Store } from "../base/store"
import { tail } from "../base/files"

// The capture (KTD14, R23): what sessions did, as observation facts in the graph, with no model call. Each root session is
// read from where the last capture stopped (its byte offset, kept in the graph's meta with what the session was doing
// then), so capturing again writes nothing twice; the offsets and the facts are written in one immediate transaction, so
// two captures at once take turns. A fork is captured from its last `forked` line on, as the recall index does.
// Observations: a turn (the user's goal and the answer), a command, a check and its verdict, a file effect and how it
// went. Each carries source session:<id>#<byte offset of its line>, source_trust asserted, valid_from when it happened,
// and attributes project, origin (user, or the job's: cron …) and agent (a named agent's; none for empty-vessel itself).
// Each project gets one existence fact the first time a session of it is seen.
// ponytail: root sessions only (as recall); a sub-agent's session would be captured with origin subagent if it's needed.
const CAPTURED = "empty-vessel.captured" // meta key: { <session id>: Seen }
type Seen = { offset: number; project: string; origin: string; agent?: string; goal?: string }

const short = (text: unknown, n = 300) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, n)

// What one entry is as an observation, if anything; `seen` follows the turn (its goal, origin and agent).
const observe = (e: LogEntry, seen: Seen): { kind: string; text: string } | undefined => {
  if (e.role === "agent") return void (seen.agent = e.text)
  if (e.role === "user") return void Object.assign(seen, { goal: short(e.text), origin: e.origin ?? "user" })
  if (e.role === "command") return { kind: "command", text: short(`${e.text}${e.args?.summary ?? e.args?.command ? `: ${e.args.summary ?? e.args.command}` : ""}`) }
  if (e.role === "check") return { kind: "check", text: short(`check ${e.verdict}: ${e.text}`) }
  if (e.role === "effect" && e.outcome !== undefined) return { kind: "effect", text: short(`${e.text} → ${e.outcome}`) }
  if (e.role !== "assistant") return

  const goal = seen.goal
  delete seen.goal
  return { kind: "turn", text: `${goal ? `${goal} → ` : ""}${short(e.text)}` }
}

const pass = (g: Graph, folder: (key: string) => string, ids: ReadonlyArray<string>) => {
  const row = g.db.query("SELECT value FROM meta WHERE key = ?").get(CAPTURED) as { value: string } | null
  const captured: Record<string, Seen> = row ? JSON.parse(row.value) : {}
  let sessions = 0, observations = 0

  for (const id of ids) {
    const file = folder(`${SESSIONS}/${id}/main.jsonl`)
    let size: number
    try { size = statSync(file).size } catch { continue }
    const known = captured[id]
    if (size <= (known?.offset ?? 0)) continue // ponytail: a file rewritten shorter is left as captured

    // Its new whole lines, each with where it starts.
    const { text, read } = tail(file, known?.offset ?? 0, size)
    let lines: Array<{ at: number; e: LogEntry }> = []
    let at = known?.offset ?? 0
    for (const raw of text.split("\n").slice(0, -1)) {
      const e = logEntries(raw)[0]
      if (e) lines.push({ at, e })
      at += Buffer.byteLength(raw) + 1
    }

    let seen = known
    if (!seen) {
      const head = lines[0]?.e
      if (head?.role !== "project") continue // not a session's start yet: next capture
      seen = { offset: 0, project: projectOf(head.text), origin: "user" }
      lines = lines.slice(Math.max(0, lines.findLastIndex((l) => l.e.role === "forked")))
      if (!query(g, { attrs: { role: "existence", project: seen.project }, limit: 1 }).length)
        add(g, { kind: "project", text: seen.project, attrs: { role: "existence", project: seen.project } })
    }

    for (const { at, e } of lines) {
      const o = observe(e, seen)
      if (!o) continue
      const attrs = { project: seen.project, origin: seen.origin, ...(seen.agent ? { agent: seen.agent } : {}) }
      add(g, { ...o, attrs, source: `session:${id}#${at}`, source_trust: "asserted", valid_from: e.ts })
      observations++
    }

    captured[id] = { ...seen, offset: (known?.offset ?? 0) + read }
    sessions++
  }

  g.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [CAPTURED, JSON.stringify(captured)])
  return { sessions, observations }
}

// Capture every root session in the Store into the graph: how many sessions had new lines, and the observations written.
export const captureSessions = Effect.gen(function* () {
  const store = yield* Store
  const ids = yield* store.list(SESSIONS)
  const gm = yield* GraphMemory

  return yield* gm.use((g) => withRetry(() => g.db.transaction(() => pass(g, store.folder, ids)).immediate()))
})

// `empty-vessel graph stats`: the facts not retired, counted by kind and status, one line per kind.
export const graphStats = Effect.flatMap(GraphMemory, (gm) => gm.use((g) => {
  const rows = g.db.query("SELECT kind, status, count(*) AS n FROM facts WHERE retired_at IS NULL GROUP BY kind, status ORDER BY kind, status").all() as Array<{ kind: string; status: string; n: number }>
  const kinds = Map.groupBy(rows, (r) => r.kind)
  return [...kinds].map(([kind, rs]) => `${kind}: ${rs.map((r) => `${r.n} ${r.status}`).join(", ")}`).join("\n") || "the graph is empty"
}))
