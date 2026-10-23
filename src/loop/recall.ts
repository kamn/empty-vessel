import { Database } from "bun:sqlite"
import { closeSync, openSync, readSync, statSync } from "node:fs"
import { Effect } from "effect"
import { type LogEntry, logEntries, SESSIONS } from "../base/session"
import { Store } from "../base/store"

// The recall index (KTD23): every root session's messages in an SQLite FTS5 table at <home>/recall.db, for pastSessions
// (src/loop/past.ts). Each search first brings it up to date: a session file whose size hasn't changed isn't read; one
// that grew is read from where the last pass stopped (its byte offset; entries numbered on from its last seq). A fork
// (a copy of its parent's log, src/base/session.ts forkSession) is indexed only after its last `forked` line, so the
// parent's words aren't found twice. Sub-agents' sessions (sessions/<root>/<child>) aren't indexed: their parent's
// answer has what came of them. A deleted session's rows go on the next pass, and the file is VACUUMed then (and weekly),
// so a secret pasted into a deleted session doesn't linger in the index.
// ponytail: stats every session file on each search; a change feed from the recorder if that gets slow.

const WEEK = 7 * 24 * 3600 * 1000

// A message as recall sees it: the user's own words, empty-vessel's answers, and (for reading a session back, never
// searched) system entries: a message no user wrote (a job's prompt, a detached sub-agent's result: its `origin`).
export type Said = { readonly seq: number; readonly ts: number; readonly role: "user" | "assistant" | "system"; readonly text: string }

// Number a session's entries the way the index does: their own `seq`, or one past the previous (an old file without one).
export const numbered = (entries: ReadonlyArray<LogEntry>, last = -1): Array<LogEntry & { seq: number }> =>
  entries.map((e) => ({ ...e, seq: (last = typeof e.seq === "number" ? e.seq : last + 1) }))

export const said = (e: LogEntry & { seq: number }): Said | undefined =>
  typeof e.text !== "string" || !e.text ? undefined
    : e.role === "assistant" ? { seq: e.seq, ts: e.ts, role: "assistant", text: e.text }
    : e.role !== "user" ? undefined
    : e.origin && e.origin !== "user" ? { seq: e.seq, ts: e.ts, role: "system", text: `[not from the user (origin: ${e.origin})] ${e.text}` }
    : { seq: e.seq, ts: e.ts, role: "user", text: e.text }

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project TEXT NOT NULL, started INTEGER NOT NULL, offset INTEGER NOT NULL, seq INTEGER NOT NULL)",
  "CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(text, session UNINDEXED, project UNINDEXED, role UNINDEXED, seq UNINDEXED, ts UNINDEXED, tokenize = 'porter unicode61')",
  "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
]

// The index, opened for one use and closed after. WAL lets searches read while another process indexes; the busy
// timeout makes a second indexer wait its turn instead of failing.
export const withIndex = <A, E, R>(use: (db: Database) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const file = (yield* Store).folder("recall.db")
    return yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          const db = new Database(file, { create: true })
          db.run("PRAGMA busy_timeout = 10000")
          // WAL stays set in the file once any opener sets it; switching can fail "locked" (no busy wait) while a
          // second process opens a new index at the same moment: that one sets it, and the busy timeout covers the rest.
          try { db.run("PRAGMA journal_mode = WAL") } catch {}
          return db
        },
        catch: (cause) => new Error(`can't open the recall index ${file}: ${cause}`),
      }),
      use,
      (db) => Effect.sync(() => db.close()),
    )
  })

// The bytes of `file` from `offset` up to its last whole line (a line being appended right now waits for the next pass).
const tail = (file: string, offset: number, size: number) => {
  const bytes = Buffer.alloc(size - offset)
  const fd = openSync(file, "r")
  try { readSync(fd, bytes, 0, bytes.length, offset) } finally { closeSync(fd) }

  const end = bytes.lastIndexOf(10) + 1
  return { text: bytes.subarray(0, end).toString("utf8"), read: end }
}

type Row = { project: string; started: number; offset: number; seq: number }

// One pass, in one BEGIN IMMEDIATE transaction: each session's row (where its last pass stopped) is read inside it, so two
// processes indexing at once take turns and never add the same entries twice.
const pass = (db: Database, store: Store["Service"], ids: ReadonlyArray<string>) => db.transaction(() => {
  for (const sql of SCHEMA) db.run(sql)
  const known = new Map(db.query<{ id: string } & Row, []>("SELECT * FROM sessions").all().map((r) => [r.id, r]))
  const add = db.prepare("INSERT INTO entries (text, session, project, role, seq, ts) VALUES (?, ?, ?, ?, ?, ?)")
  const save = db.prepare("INSERT OR REPLACE INTO sessions (id, project, started, offset, seq) VALUES (?, ?, ?, ?, ?)")
  const drop = (id: string) => {
    db.run("DELETE FROM entries WHERE session = ?", [id])
    db.run("DELETE FROM sessions WHERE id = ?", [id])
  }

  const present = new Set(ids)
  let dropped = 0
  for (const id of known.keys()) {
    if (!present.has(id)) (drop(id), dropped++)
  }

  for (const id of ids) {
    const file = store.folder(`${SESSIONS}/${id}/main.jsonl`)
    let size: number
    try { size = statSync(file).size } catch { continue }

    let row: Row | undefined = known.get(id)
    if (row && size === row.offset) continue
    if (row && size < row.offset) (drop(id), row = undefined) // rewritten shorter: index it afresh

    const { text, read } = tail(file, row?.offset ?? 0, size)
    let entries = numbered(logEntries(text), row?.seq ?? -1)

    if (!row) {
      const head = entries[0]
      if (head?.role !== "project") continue // not a session's start yet: next pass
      row = { project: head.checks ?? head.text, started: head.ts, offset: 0, seq: -1 }
      const forked = entries.findLastIndex((e) => e.role === "forked")
      if (forked >= 0) entries = entries.slice(forked)
    }

    for (const e of entries) {
      const s = said(e)
      if (s && s.role !== "system") add.run(s.text, id, row.project, s.role, s.seq, s.ts)
    }

    save.run(id, row.project, row.started, row.offset + read, entries.at(-1)?.seq ?? row.seq)
  }

  return dropped
}).immediate()

// Bring the index up to date with the root sessions in the Store. After a pass that dropped a session (or a week after the
// last), VACUUM, so dropped text is gone from the file too; a busy index skips it (the next pass tries again).
export const indexSessions = Effect.gen(function* () {
  const store = yield* Store
  const ids = yield* store.list(SESSIONS)

  return yield* withIndex((db) => Effect.try({
    try: () => {
      const dropped = pass(db, store, ids)
      const last = db.query<{ value: number }, []>("SELECT value FROM meta WHERE key = 'vacuumed'").get()?.value
      if (!dropped && last !== undefined && Date.now() - last < WEEK) return

      try {
        db.run("VACUUM")
        db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('vacuumed', ?)", [Date.now()])
      } catch {}
    },
    catch: (cause) => new Error(`indexing past sessions failed: ${cause}`),
  }))
})
