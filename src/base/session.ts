import { randomUUIDv7 } from "bun"
import { Context, Data, Effect } from "effect"
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
type Role = "skill" | "project" | "resumed" | "systemTwo" | "agent" | "user" | "assistant" | "spawn" | "result" | "decision" | "step" | "command" | "check" | "review" | "compact" |
  "thread" | "stash" | "actions" | "given" | "size" | "code" | "shown" | "tools" | "steer" | "scope" | "flag" | "memory"
// steer: what the user typed mid-run, as System Two got it; scope: the note System Two got when its changes reached
// another part of the project; flag: the user's /flag (never sent to System Two; read by /refine, src/loop/signals.ts)

// Extra fields per entry type: `child` on spawn/result (the sub-agent's id = subfolder name),
// `confidence` and `done` on decision (how sure System One was; how likely the goal is already achieved),
// the arguments and output tail on command, the verdict on check.
type Recorder = (role: Role, text: string, extra?: Readonly<Record<string, unknown>>) => Effect.Effect<void, SessionError>

// Appends one entry to the session's main.jsonl in the Store.
const recorder = (store: Store["Service"], key: string): Recorder => (role, text, extra = {}) =>
  Effect.gen(function* () {
    const ts = Date.now()
    yield* store.append(`${key}/main.jsonl`, JSON.stringify({ role, text, ...extra, ts }) + "\n")
    yield* (yield* SessionMirror)({ key, role, text, extra, ts })
  })

// Every agent is a key with a main.jsonl (one JSON entry per line, append-only).
// Its sub-agents are keys inside it: sessions/<root>/<child>/<grandchild>/main.jsonl
// `dir` is the same key as a folder on disk, where the session's kernel keeps its files.
export const makeSession = (parentKey: string) => Effect.gen(function* () {
  const store = yield* Store
  const id = randomUUIDv7()
  const key = `${parentKey}/${id}`
  const record = recorder(store, key)

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

    const record = recorder(store, key)
    yield* record("resumed", process.cwd())
    return { id: key.split("/").at(-1)!, key, dir: store.folder(key), record } as const
  })

// The newest session started in this folder (session ids are time-ordered), like Claude Code's --continue.
export const latestSession = (cwd: string) =>
  Effect.gen(function* () {
    const store = yield* Store

    for (const id of [...(yield* store.list(SESSIONS))].reverse()) {
      const first = (yield* store.get(`${SESSIONS}/${id}/main.jsonl`))?.split("\n", 1)[0]
      try { if (first && JSON.parse(first).text === cwd) return `${SESSIONS}/${id}` } catch {}
    }

    return undefined
  })
