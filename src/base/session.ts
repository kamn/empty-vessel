import { randomUUIDv7 } from "bun"
import { cp, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Context, Data, Effect, Semaphore } from "effect"
import { takeLease } from "./files"
import { projectDir } from "./project"
import { Store } from "./store"

// Every session failure (can't find it to resume) becomes this one typed error.
export class SessionError extends Data.TaggedError("SessionError")<{ cause: unknown }> {}

export const SESSIONS = "sessions" // the Store key every root session sits under

// Optional provider-owned export. The normal Store remains the source of truth.
export type SessionEntry = { readonly key: string; readonly role: string; readonly text: string; readonly ts: number; readonly extra: Readonly<Record<string, unknown>> }
export type SessionMirrorFn = (entry: SessionEntry) => Effect.Effect<void>
export const SessionMirror = Context.Reference<SessionMirrorFn>("empty-vessel/SessionMirror", {
  defaultValue: () => () => Effect.void,
})
// Scoped to a turn so concurrent children and auxiliary model calls use the right session.
export const CurrentSession = Context.Reference<SessionHandle | undefined>("empty-vessel/CurrentSession", {
  defaultValue: () => undefined,
})

// What a session file holds. For resuming: thread (an item System Two added), stash (an output System One hid),
// actions (System One's line for a turn), given (a file System Two was given), size (the thread's size), resumed,
// code (a piece of code System Two declared), shown (the library tools on System One's shortlist this turn), tools (a library tool handed to System One).
const ROLES = ["usage", "skill", "project", "resumed", "systemTwo", "agent", "user", "assistant", "spawn", "result", "decision", "step", "command", "check", "review", "compact",
  "thread", "stash", "actions", "given", "size", "code", "shown", "tools", "steer", "scope", "flag", "memory", "forked", "checkpoint", "undone"] as const
type Role = typeof ROLES[number]
const known = new Set<string>(ROLES)
// steer: what the user typed mid-run, as System Two got it; scope: the note System Two got when its changes reached
// another part of the project; flag: the user's /flag (never sent to System Two; read by /refine, src/loop/signals.ts)

// Extra fields per entry type: `child` on spawn/result (the sub-agent's id = subfolder name),
// `confidence` and `done` on decision (how sure System One was; how likely the goal is already achieved),
// the arguments and output tail on command, the verdict on check.
// `sync` waits for the entry to reach the disk (fsync), for entries a crash mustn't lose.
type Recorder = (role: Role, text: string, extra?: Readonly<Record<string, unknown>>, options?: { readonly sync?: boolean }) => Effect.Effect<void, SessionError>

// One entry of a session file, as read back: its type, and whatever fields that type has.
export type LogEntry = { readonly role: Role; readonly text: string; readonly ts: number; readonly seq?: number; readonly [field: string]: any }

// Every whole entry of a session file (main.jsonl's text), in order. The one reader of session files: a line cut short
// (the process killed mid-append) and an entry of a type this version doesn't know (a newer one wrote it) are skipped.
export const logEntries = (text: string | undefined): Array<LogEntry> =>
  (text ?? "").split("\n").flatMap((line) => {
    try {
      const e = JSON.parse(line)
      return e && typeof e === "object" && known.has(e.role) ? [e] : []
    } catch { return [] }
  })

// The one writer of a session's main.jsonl in the Store. Opening it cuts a torn last line (so the next entry starts on its
// own line) and carries on the file's `seq` (an old file without one: from its line count). Entries are appended one at a
// time, so the file's order is `seq` order. An append that failed may have half-landed: the session stops writing then.
const recorder = (store: Store["Service"], key: string) => Effect.gen(function* () {
  const file = `${key}/main.jsonl`
  const text = (yield* store.get(file)) ?? ""
  const whole = text.slice(0, text.lastIndexOf("\n") + 1)
  if (whole !== text) yield* store.put(file, whole)

  let seq = 0, broken = false
  for (const line of whole.split("\n")) {
    try {
      const e = JSON.parse(line)
      seq = typeof e?.seq === "number" ? e.seq + 1 : seq + 1
    } catch {}
  }

  const one = Semaphore.makeUnsafe(1)
  const record: Recorder = (role, text, extra = {}, options) => Effect.gen(function* () {
    if (broken) return yield* Effect.fail(new SessionError({ cause: `${file}: an earlier append may be half written; not writing more` }))

    const ts = Date.now()
    yield* store.append(file, JSON.stringify({ role, text, ...extra, seq: seq++, ts }) + "\n", options).pipe(Effect.onError(() => Effect.sync(() => { broken = true })))
    yield* (yield* SessionMirror)({ key, role, text, extra, ts })
  }).pipe(one.withPermits(1))

  return record
})

// One process writes a root session at a time (sessions/<id>/owner.json, src/base/files.ts). Sub-agents' sessions sit
// inside their root's folder and are written by its owner.
// ponytail: the owner file stays when the process ends; the next opener takes it over (its pid is dead).
const own = (store: Store["Service"], key: string) => Effect.gen(function* () {
  const holder = yield* takeLease(`${store.folder(key)}/owner.json`)
  if (holder) return yield* Effect.fail(new SessionError({ cause: `${key} is open in another process (pid ${holder.pid})` }))
})

// Every agent is a key with a main.jsonl (one JSON entry per line, append-only).
// Its sub-agents are keys inside it: sessions/<root>/<child>/<grandchild>/main.jsonl
// `dir` is the same key as a folder on disk, where the session's kernel keeps its files.
export const makeSession = (parentKey: string) => Effect.gen(function* () {
  const store = yield* Store
  const id = randomUUIDv7()
  const key = `${parentKey}/${id}`
  if (parentKey === SESSIONS) yield* own(store, key)
  const record = yield* recorder(store, key)

  // First line: where this session works, so a later reader (the reviewer) knows which project it belongs to.
  // `checks` is the project's stable home (from the repo's shared .git), since a worktree folder may be gone by then.
  yield* record("project", process.cwd(), { checks: projectDir(process.cwd()) })

  return { id, key, dir: store.folder(key), record } as const
})

// What a session looks like ({ id, key, dir, record }), new or reopened.
export type SessionHandle = Effect.Success<ReturnType<typeof makeSession>>

// Reopen an existing session to keep appending to it (resume). Its first lines stay as they were.
export const openSession = (key: string) =>
  Effect.gen(function* () {
    const store = yield* Store
    if (!(yield* store.list(key)).includes("main.jsonl")) return yield* Effect.fail(new SessionError({ cause: `no session at ${key}` }))

    yield* own(store, key)
    const record = yield* recorder(store, key)
    yield* record("resumed", process.cwd())
    return { id: key.split("/").at(-1)!, key, dir: store.folder(key), record } as const
  })

// A copy of a session to go on from, leaving the original as it was (Claude Code's --fork-session, Pi's /fork): its
// conversation, kernel (cells and their definitions), sub-agents and saved view, under a new id. Paths and ids in the
// copy's text files point at the copy. Usage lines are left out, so the original's spending isn't counted twice.
// Returns the copy's key, to open as a resumed session.
export const forkSession = (key: string) =>
  Effect.gen(function* () {
    const store = yield* Store
    if (!(yield* store.list(key)).includes("main.jsonl")) return yield* Effect.fail(new SessionError({ cause: `no session at ${key}` }))

    const from = key.split("/").at(-1)!, to = randomUUIDv7()
    const copy = `${key.slice(0, -from.length)}${to}`
    const source = store.folder(key), target = store.folder(copy)

    yield* Effect.tryPromise({
      try: async () => {
        await cp(source, target, { recursive: true, filter: (path) => path !== join(source, "owner.json") }) // the copy has no owner yet
        for (const entry of await readdir(target, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile() || !/\.(jsonl|json|ts)$/.test(entry.name)) continue
          const file = join(entry.parentPath, entry.name)
          let text = (await readFile(file, "utf8")).replaceAll(source, target).replaceAll(from, to)
          if (entry.name === "main.jsonl") text = text.split("\n").filter((l) => !l.startsWith('{"role":"usage"')).join("\n")
          await writeFile(file, text)
        }
      },
      catch: (cause) => new SessionError({ cause }),
    })

    yield* (yield* recorder(store, copy))("forked", from)
    return copy
  })

// The newest sessions started in `cwd` (every folder's, if undefined), up to `limit`: for choosing one to --resume.
// Each with when it started, how many messages you sent, and the first of them.
export type SessionSummary = { readonly id: string; readonly started: number; readonly folder: string; readonly messages: number; readonly first?: string }
export const listSessions = (cwd: string | undefined, limit = 20) =>
  Effect.gen(function* () {
    const store = yield* Store
    const found: Array<SessionSummary> = []

    for (const id of [...(yield* store.list(SESSIONS))].reverse()) {
      const entries = logEntries(yield* store.get(`${SESSIONS}/${id}/main.jsonl`))
      const head = entries[0]
      if (head?.role !== "project" || (cwd !== undefined && head.text !== cwd)) continue

      const said = entries.filter((e) => e.role === "user")
      found.push({ id, started: head.ts, folder: head.text, messages: said.length, ...(said[0] ? { first: said[0].text } : {}) })
      if (found.length >= limit) break
    }

    return found
  })

// One line per session, for the terminal.
export const sessionLines = (sessions: ReadonlyArray<SessionSummary>, withFolder: boolean) =>
  sessions.map((s) => {
    const when = new Date(s.started).toLocaleString("sv").slice(0, 16) // 2026-10-20 23:21
    const first = s.first ? ` "${s.first.replace(/\s+/g, " ").slice(0, 60)}${s.first.length > 60 ? "…" : ""}"` : ""
    return `${s.id}  ${when}  ${String(s.messages).padStart(3)} message${s.messages === 1 ? " " : "s"}${withFolder ? `  ${s.folder}` : ""}${first}`
  })

// The newest session started in this folder (session ids are time-ordered), like Claude Code's --continue.
export const latestSession = (cwd: string) =>
  Effect.gen(function* () {
    const store = yield* Store

    for (const id of [...(yield* store.list(SESSIONS))].reverse()) {
      if (logEntries(yield* store.get(`${SESSIONS}/${id}/main.jsonl`))[0]?.text === cwd) return `${SESSIONS}/${id}`
    }

    return undefined
  })
