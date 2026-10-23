import { Effect, Option, Schema } from "effect"
import { projectDir } from "../base/project"
import { logEntries, SESSIONS } from "../base/session"
import { Store } from "../base/store"
import { Reviewer } from "../learning/reviewer"
import { indexSessions, numbered, said, withIndex } from "./recall"
import type { PastArgs, PastMessage, PastResult, PastSession } from "../tools/kernel-builtins"

// pastSessions: what was said in earlier sessions, for "what did we decide about X?" (Hermes's session search, beside its
// curated memory), from the recall index (src/loop/recall.ts). Three modes:
// - discover (the default; a bare query string is one): the sessions whose messages (the user's and empty-vessel's
//   answers) hold every word of the query, best match first, each with up to three excerpts, matches in **bold**; the best
//   hit comes whole (up to FULL characters). Only this project's sessions (a session belongs to the project its first line
//   names; worktrees of one repo count as one) unless `allProjects: true`. `summarize: true` adds the reviewer's summary.
// - scroll: the messages around one (`session`, `seq` from a hit, `window` either side).
// - read: a whole session's messages, up to READ characters.
// The types are the kernel's built-in's (src/tools/kernel-builtins.ts), so cells and this agree.
export type { PastArgs, PastMessage, PastResult, PastSession } from "../tools/kernel-builtins"

const FULL = 2000, READ = 60_000, PER_SESSION = 3

const iso = (ts: number) => new Date(ts).toISOString()

// The best hit, whole, or (if long) from a little before its first match.
const fuller = (text: string) => {
  if (text.length <= FULL) return text
  const at = Math.max(0, text.indexOf("**") - FULL / 4)
  return `${at > 0 ? "…" : ""}${text.slice(at, at + FULL)}${at + FULL < text.length ? "…" : ""}`
}

type Hit = { rowid: number; session: string; started: number; role: PastMessage["role"]; seq: number; ts: number; excerpt: string; full?: string }

const discover = (query: string, options: { readonly cwd: string; readonly exclude?: string; readonly limit: number; readonly allProjects: boolean }) =>
  Effect.gen(function* () {
    const words = query.split(/\s+/).filter(Boolean)
    if (!words.length) return []
    yield* indexSessions

    // Every word as a quoted FTS5 term: the query's own punctuation is never FTS syntax.
    const match = words.map((w) => `"${w.replaceAll('"', '""')}"`).join(" ")
    const projects = options.allProjects ? [] : [projectDir(options.cwd), options.cwd]
    // Only the best hit is shown whole, so only it is highlighted whole.
    const hits = yield* withIndex((db) => Effect.try({
      try: () => {
        const rows = db.query<Hit, Array<string>>(
          `SELECT rowid, session, role, seq, ts, (SELECT started FROM sessions WHERE id = session) AS started,
            snippet(entries, 0, '**', '**', '…', 24) AS excerpt
          FROM entries WHERE entries MATCH ? AND session != ? ${projects.length ? "AND project IN (?, ?)" : ""} ORDER BY bm25(entries) LIMIT 200`,
        ).all(match, options.exclude ?? "", ...projects)
        const top = rows[0]
        if (top) top.full = db.query<{ full: string }, [string, number]>(`SELECT highlight(entries, 0, '**', '**') AS full FROM entries WHERE entries MATCH ? AND rowid = ?`).get(match, top.rowid)?.full

        return rows
      },
      catch: (cause) => new Error(`searching past sessions failed: ${cause}`),
    }))

    const found = new Map<string, { session: string; started: string; messages: Array<PastMessage> }>()
    for (const h of hits) {
      const s = found.get(h.session) ?? (found.size < options.limit ? { session: h.session, started: iso(h.started), messages: [] } : undefined)
      if (!s || s.messages.length >= PER_SESSION) continue

      found.set(h.session, s)
      s.messages.push({ seq: h.seq, at: iso(h.ts), role: h.role, text: found.size === 1 && !s.messages.length ? fuller(h.full ?? "") : h.excerpt })
    }

    return [...found.values()]
  })

// One root session's messages, numbered as the index numbers them. Only an id the Store lists (never a path).
const messagesOf = (id: string | undefined) =>
  Effect.gen(function* () {
    const store = yield* Store
    if (!id || !(yield* store.list(SESSIONS)).includes(id)) return yield* Effect.fail(new Error(`no session ${id ?? "(none given)"}`))

    const entries = numbered(logEntries(yield* store.get(`${SESSIONS}/${id}/main.jsonl`)))
    const messages = entries.flatMap((e) => {
      const s = said(e)
      return s ? [{ seq: s.seq, at: iso(s.ts), role: s.role, text: s.text }] : []
    })
    return { session: id, started: iso(entries[0]?.ts ?? 0), messages }
  })

const SUMMARY = "Below are excerpts from a coding agent's earlier sessions that matched a search. In a few sentences, say what they tell about the query, naming the session each point comes from. If they don't answer it, say so. Don't add anything they don't say."

const summarize = (query: string, sessions: ReadonlyArray<PastSession>) =>
  Effect.gen(function* () {
    const reviewer = yield* Effect.serviceOption(Reviewer)
    if (Option.isNone(reviewer)) return yield* Effect.fail(new Error("summarize needs a model to ask (the reviewer)"))

    const input = [`Query: ${query}`, ...sessions.map((s) => `## Session ${s.session} (${s.started})\n${s.messages.map((m) => `${m.role}: ${m.text}`).join("\n")}`)].join("\n\n")
    const { value } = yield* reviewer.value.ask(SUMMARY, Schema.Struct({ summary: Schema.String }), input).pipe(Effect.mapError((e) => new Error(`summarizing failed: ${e.message}`)))
    return value.summary
  })

// `exclude`: this conversation's own session. A string is a discover query (how pastSessions was first called).
export const pastSessions = (args: string | PastArgs, options: { readonly cwd: string; readonly exclude?: string }) =>
  Effect.gen(function* () {
    const a: PastArgs = typeof args === "string" ? { query: args } : args

    if (a.mode === "scroll") {
      if (typeof a.seq !== "number") return yield* Effect.fail(new Error("scroll needs the seq of a hit (from discover)"))
      const s = yield* messagesOf(a.session)
      const window = Math.min(Math.max(a.window ?? 5, 0), 50)
      const i = s.messages.findIndex((m) => m.seq >= a.seq!), at = i < 0 ? s.messages.length - 1 : i // past the last: the end
      return { sessions: [{ ...s, messages: s.messages.slice(Math.max(0, at - window), at + window + 1) }] } satisfies PastResult
    }

    if (a.mode === "read") {
      const s = yield* messagesOf(a.session)
      let left = READ
      const kept = s.messages.filter((m) => (left -= m.text.length) >= 0)
      return { sessions: [{ ...s, messages: kept }], ...(kept.length < s.messages.length ? { truncated: true } : {}) } satisfies PastResult
    }

    const query = a.query ?? ""
    const sessions = yield* discover(query, { cwd: options.cwd, exclude: options.exclude, limit: Math.min(a.limit ?? 5, 20), allProjects: a.allProjects === true })
    if (!a.summarize || !sessions.length) return { sessions } satisfies PastResult
    return { sessions, summary: yield* summarize(query, sessions) } satisfies PastResult
  })
