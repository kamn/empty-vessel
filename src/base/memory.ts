import { Context, Data, Effect, Layer } from "effect"
import { withLock } from "./files"
import { projectDir } from "./project"
import { Store } from "./store"

// What empty-vessel remembers across sessions, one "- " line per entry, in three scopes: this project (its setup, commands,
// conventions), the agent (this machine and its tools: what it learned that holds in every project), kept in the agent's
// folder: ~/.empty-vessel/agents/memory.md for empty-vessel itself (the root), agents/<name>/memory.md for a named agent,
// which also sees the root's; and the user (who the user is and how they work; never machine facts), one profile for
// every agent at agents/user.md (not user.md at the home's root: on a case-insensitive disk that's the old ~/.empty-vessel/user.md).
// An earlier user scope was dropped because the model misfiled into it, so each scope's description is strict and the
// reviewer is shown one example per scope. A service, so another memory (Honcho, Mem0, …) can stand in for this one,
// which keeps each scope as a file in the Store. Each scope has a size limit (Hermes's rule): a write that would go over
// it fails until entries are merged or removed, so memory stays a few short lines rather than piling up (short notes
// help a coding agent; volume hurts).
export type Scope = "agent" | "project" | "user"
export type Limits = Readonly<Record<Scope, number>> // characters per scope (per agent, for "agent")
export const SCOPES: ReadonlyArray<Scope> = ["agent", "project", "user"]

export class MemoryError extends Data.TaggedError("MemoryError")<{ message: string }> {}

export class Memory extends Context.Service<Memory, {
  readonly snapshot: Effect.Effect<string> // every scope, for the prompt at the start of a session
  readonly add: (scope: Scope, text: string) => Effect.Effect<void, MemoryError> // fails when the scope is full
  readonly replace: (scope: Scope, old: string, text: string) => Effect.Effect<void, MemoryError> // the one entry containing `old`
  readonly remove: (scope: Scope, old: string) => Effect.Effect<void, MemoryError>
  readonly entries: (scope: Scope) => Effect.Effect<ReadonlyArray<string>> // the active agent's own (empty-vessel memory)
  readonly file: (scope: Scope) => Effect.Effect<string> // where it's kept, relative to the Store (to edit by hand)
}>()("empty-vessel/Memory") {}

// The agent a conversation works as ("root": empty-vessel itself): set by src/answer.ts (useAgent) and, for a sub-agent, by
// src/loop/turn.ts. Read whenever memory is used, so one Memory serves every agent.
export const ActiveAgent = Context.Reference<string>("empty-vessel/ActiveAgent", { defaultValue: () => "root" })

// The default limits: about 6,000 characters, ~1,500 tokens of System Two's briefing (Hermes keeps 2,200 and 1,375).
export const LIMITS: Limits = { agent: 2400, project: 2200, user: 1375 }
// The limits config.json's memory section sets, and how many characters a scope's entries take (one line each).
export const memoryLimits = (m: { readonly agentChars: number; readonly projectChars: number; readonly userChars: number }): Limits =>
  ({ agent: m.agentChars, project: m.projectChars, user: m.userChars })
export const usedChars = (entries: ReadonlyArray<string>) => entries.reduce((n, e) => n + e.length + 1, 0)

const agentKey = (agent: string) => (agent === "root" ? "agents/memory.md" : `agents/${agent}/memory.md`)
const PROFILE = "agents/user.md"
const BACKUP = "agents/memory.before-profile.md" // agent memory as it was before the profile's migration; also says it ran

// Agent memory entries about the user (their preferences, how they work), moved to the profile once.
// ponytail: a fixed pattern on how the entry starts; entries worded otherwise stay in agent memory (moved by hand, /memory).
const ABOUT_USER = /^- (the )?user\b|^- (i )?prefers?\b/i

// The memory for the project at `root`, in the Store: agents/[<name>/]memory.md, agents/user.md and projects/<project>/learned.md.
export const memoryOnStore = (root: string, given: Partial<Limits> = {}) =>
  Layer.effect(Memory, Effect.gen(function* () {
    const store = yield* Store
    const limits: Limits = { ...LIMITS, ...given }
    const lines = (key: string) => store.get(key).pipe(Effect.map((text) => (text ?? "").split("\n").filter((l) => l.trim())))
    const key = (scope: Scope) => Effect.gen(function* () { return scope === "project" ? `${projectDir(root, "")}/learned.md` : scope === "user" ? PROFILE : agentKey(yield* ActiveAgent) })
    const entries = (scope: Scope) => Effect.flatMap(key(scope), lines)

    // Once: the old notes about the user and this machine become empty-vessel's own (all of them, even over the limit: the
    // next write consolidates). The old files stay where they are, no longer read. Not after the profile's migration
    // below, which may leave agent memory empty.
    if ((yield* store.get(BACKUP)) === undefined && !(yield* store.get(agentKey("root")))) {
      const old = [...(yield* lines("user.md")), ...(yield* lines("learned.md"))]
      if (old.length) yield* store.put(agentKey("root"), old.map((l) => `${l}\n`).join(""))
    }

    // Once (KTD19): empty-vessel's own entries about the user move to the profile (all of them, even over its limit);
    // machine facts stay. Undo: copy the backup over agents/memory.md and move the profile's lines back.
    yield* withLock(store.folder(agentKey("root")), Effect.gen(function* () {
      if ((yield* store.get(BACKUP)) !== undefined) return
      const before = (yield* store.get(agentKey("root"))) ?? ""
      const all = yield* lines(agentKey("root"))
      const moved = all.filter((l) => ABOUT_USER.test(l))
      yield* store.put(BACKUP, before)
      if (!moved.length) return

      yield* store.put(PROFILE, [...(yield* lines(PROFILE)), ...moved].map((l) => `${l}\n`).join(""))
      yield* store.put(agentKey("root"), all.filter((l) => !ABOUT_USER.test(l)).map((l) => `${l}\n`).join(""))
      yield* Effect.logInfo(`memory: moved ${moved.length} entries about the user from agent memory to the profile (${PROFILE}); the old file is ${BACKUP}`)
    }))

    // A scope's entries written whole, if they fit its limit, or if they're smaller than before (a file already over
    // its limit loads as it is; the next write has to make it smaller).
    const write = (scope: Scope, before: ReadonlyArray<string>, after: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (usedChars(after) > limits[scope] && usedChars(after) > usedChars(before))
          return yield* new MemoryError({ message: `${scope} memory is full (${usedChars(after)} of ${limits[scope]} characters): merge or remove an entry first` })
        yield* store.put(yield* key(scope), after.map((l) => `${l}\n`).join(""))
      })

    // Read → change → write while holding the scope's file lock, so two writers at once (sub-agents, other sessions)
    // can't lose one's change.
    const locked = <A, E>(scope: Scope, use: Effect.Effect<A, E>) => Effect.flatMap(key(scope), (k) => withLock(store.folder(k), use))

    // The entries with the one containing `old` changed (a string) or dropped (undefined); none or several is an error.
    const change = (scope: Scope, old: string, to: string | undefined) =>
      locked(scope, Effect.gen(function* () {
        const all = yield* entries(scope)
        const found = all.filter((l) => l.includes(old))
        if (found.length !== 1) return yield* new MemoryError({ message: `${found.length ? "several" : "no"} ${scope} entries contain "${old}"` })

        yield* write(scope, all, all.flatMap((l) => (l !== found[0] ? [l] : to === undefined ? [] : [`- ${to}`])))
      }))

    // What System Two is told: the user's profile, empty-vessel's own notes, a named agent's, then the project's, each labelled.
    const snapshot = Effect.gen(function* () {
      const agent = yield* ActiveAgent
      const parts = [
        { label: "Who the user is and how they work", ls: yield* lines(PROFILE) },
        { label: "How empty-vessel works with the user", ls: yield* lines(agentKey("root")) },
        ...(agent === "root" ? [] : [{ label: `As the ${agent} agent`, ls: yield* lines(agentKey(agent)) }]),
        { label: "About this project", ls: yield* entries("project") },
      ]
      return parts.filter((p) => p.ls.length).map((p) => `${p.label}:\n${p.ls.join("\n")}`).join("\n\n")
    })

    return {
      snapshot,
      add: (scope, text) => locked(scope, Effect.flatMap(entries(scope), (all) => write(scope, all, [...all, `- ${text}`]))),
      replace: (scope, old, text) => change(scope, old, text),
      remove: (scope, old) => change(scope, old, undefined),
      entries,
      file: key,
    }
  }))
