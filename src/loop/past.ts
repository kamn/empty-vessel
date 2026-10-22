import { Effect } from "effect"
import { projectDir } from "../base/project"
import { logEntries, SESSIONS } from "../base/session"
import { Store } from "../base/store"

// pastSessions: what was said in this project's earlier sessions, for "what did we decide about X?" (Hermes's session
// search, beside its curated memory). Messages only (the user's and empty-vessel's answers), where every word of the
// query appears, newest first, each with where it came from: the session (to --resume it) and when. Another project's
// sessions are never searched: a session belongs to the project its first line names (worktrees of one repo count as one).
// ponytail: reads every session file on each search; an index if the history grows past a few thousand sessions.
export type PastMessage = { readonly session: string; readonly at: string; readonly role: "user" | "assistant"; readonly text: string }

const SNIPPET = 400 // characters around the first match

const snippet = (text: string, word: string) => {
  const at = Math.max(0, text.toLowerCase().indexOf(word) - SNIPPET / 4)
  return `${at > 0 ? "…" : ""}${text.slice(at, at + SNIPPET)}${at + SNIPPET < text.length ? "…" : ""}`
}

export const pastSessions = (query: string, options: { readonly cwd: string; readonly exclude?: string; readonly limit?: number }) =>
  Effect.gen(function* () {
    const store = yield* Store
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const checks = projectDir(options.cwd)
    const found: Array<PastMessage> = []
    if (!words.length) return found

    for (const id of [...(yield* store.list(SESSIONS))].reverse()) { // ids are time-ordered: newest first
      if (id === options.exclude) continue
      const entries = logEntries(yield* store.get(`${SESSIONS}/${id}/main.jsonl`))
      const first = entries[0]
      if (first?.role !== "project" || (first.checks ? first.checks !== checks : first.text !== options.cwd)) continue

      const hits = entries.filter((e) => (e.role === "user" || e.role === "assistant") && typeof e.text === "string" && words.every((w) => e.text.toLowerCase().includes(w)))
      for (const e of hits.reverse()) {
        found.push({ session: id, at: new Date(e.ts).toISOString(), role: e.role as PastMessage["role"], text: snippet(e.text, words[0]!) })
        if (found.length >= (options.limit ?? 20)) return found
      }
    }

    return found
  })
