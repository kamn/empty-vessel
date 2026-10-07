import { Context, Data, Effect, Layer } from "effect"
import { projectDir } from "./project"
import { Store } from "./store"

// What empty-vessel remembers across sessions, one "- " line per entry, in two scopes: this project (its setup, commands,
// conventions) and the agent (how it works with the user: their preferences and corrections, what it learned about
// this machine), kept in the agent's folder: ~/.empty-vessel/agents/memory.md for empty-vessel itself (the root),
// agents/<name>/memory.md for a named agent, which also sees the root's. There were three scopes (user, machine,
// project): the model filed a repo fact under "machine". A service, so another memory (Honcho, Mem0, …) can stand in
// for this one, which keeps each scope as a file in the Store. Each scope has a size limit (Hermes's rule): a write
// that would go over it fails until entries are merged or removed, so memory stays a few short lines rather than
// piling up (short notes help a coding agent; volume hurts).
export type Scope = "agent" | "project"
export type Limits = Readonly<Record<Scope, number>> // characters per scope (per agent, for "agent")
export const SCOPES: ReadonlyArray<Scope> = ["agent", "project"]

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

// The default limits: about 4,600 characters, ~1,200 tokens of System Two's briefing (Hermes keeps 2,200 and 1,375).
export const LIMITS: Limits = { agent: 2400, project: 2200 }

const agentKey = (agent: string) => (agent === "root" ? "agents/memory.md" : `agents/${agent}/memory.md`)

// The memory for the project at `root`, in the Store: agents/[<name>/]memory.md and projects/<project>/learned.md.
export const memoryOnStore = (root: string, limits: Limits = LIMITS) =>
  Layer.effect(Memory, Effect.gen(function* () {
    const store = yield* Store
    const lines = (key: string) => store.get(key).pipe(Effect.map((text) => (text ?? "").split("\n").filter((l) => l.trim())))
    const key = (scope: Scope) => Effect.gen(function* () { return scope === "project" ? `${projectDir(root, "")}/learned.md` : agentKey(yield* ActiveAgent) })
    const entries = (scope: Scope) => Effect.flatMap(key(scope), lines)

    // Once: the old notes about the user and this machine become empty-vessel's own (all of them, even over the limit: the
    // next write consolidates). The old files stay where they are, no longer read.
    if (!(yield* store.get(agentKey("root")))) {
      const old = [...(yield* lines("user.md")), ...(yield* lines("learned.md"))]
      if (old.length) yield* store.put(agentKey("root"), old.map((l) => `${l}\n`).join(""))
    }

    // A scope's entries written whole, if they fit its limit, or if they're smaller than before (a file already over
    // its limit loads as it is; the next write has to make it smaller).
    const size = (ls: ReadonlyArray<string>) => ls.reduce((n, l) => n + l.length + 1, 0)
    const write = (scope: Scope, before: ReadonlyArray<string>, after: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        if (size(after) > limits[scope] && size(after) > size(before))
          return yield* new MemoryError({ message: `${scope} memory is full (${size(after)} of ${limits[scope]} characters): merge or remove an entry first` })
        yield* store.put(yield* key(scope), after.map((l) => `${l}\n`).join(""))
      })

    // The entries with the one containing `old` changed (a string) or dropped (undefined); none or several is an error.
    // ponytail: read, change, write without a lock; two writers at once could lose one change (Store has no lock yet)
    const change = (scope: Scope, old: string, to: string | undefined) =>
      Effect.gen(function* () {
        const all = yield* entries(scope)
        const found = all.filter((l) => l.includes(old))
        if (found.length !== 1) return yield* new MemoryError({ message: `${found.length ? "several" : "no"} ${scope} entries contain "${old}"` })

        yield* write(scope, all, all.flatMap((l) => (l !== found[0] ? [l] : to === undefined ? [] : [`- ${to}`])))
      })

    // What System Two is told: empty-vessel's own notes, a named agent's, then the project's, each labelled.
    const snapshot = Effect.gen(function* () {
      const agent = yield* ActiveAgent
      const parts = [
        { label: "How empty-vessel works with the user", ls: yield* lines(agentKey("root")) },
        ...(agent === "root" ? [] : [{ label: `As the ${agent} agent`, ls: yield* lines(agentKey(agent)) }]),
        { label: "About this project", ls: yield* entries("project") },
      ]
      return parts.filter((p) => p.ls.length).map((p) => `${p.label}:\n${p.ls.join("\n")}`).join("\n\n")
    })

    return {
      snapshot,
      add: (scope, text) => Effect.flatMap(entries(scope), (all) => write(scope, all, [...all, `- ${text}`])),
      replace: (scope, old, text) => change(scope, old, text),
      remove: (scope, old) => change(scope, old, undefined),
      entries,
      file: key,
    }
  }))
