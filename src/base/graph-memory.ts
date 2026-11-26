import { basename } from "node:path"
import { Context, Effect, Layer, type Scope as EffectScope } from "effect"
import { ActiveAgent, agentKey, Memory, MemoryError, MemoryPull, PROFILE, type PullCandidate, type Scope, SCOPES } from "./memory"
import { projectDir } from "./project"
import { Store } from "./store"

// empty-vessel's memory as one graph for every project (KTD11): what the notes keep per scope, as facts of kind "note"
// with attributes saying whose they are: scope (user, agent, project), agent (a named agent; none for empty-vessel
// itself) and project (none for the user or this machine). A named agent sees its own facts plus the shared ones (R20).
// The Memory service still works over it (the reviewer, the kernel's memory built-in); GraphMemory is the graph itself,
// for code that reads it as optional (Effect.serviceOption): the notes plugin keeps working without it.
// The graph itself comes from a memory plugin (the bundled one, src/plugins/graph, keeps it in an empty-graph file):
// it hands graphMemory a `use` that runs GraphOps atomically on its store; everything here works over GraphOps only.
const MIGRATED = "empty-vessel.notes_migrated" // a meta key: when the notes became facts (KTD17)
const MAX_CANDIDATES = 40 // as src/loop/pull.ts shows System One

// The graph's facts and actions, backend-neutral (src/tools/kernel-builtins.ts keeps a copy for cells: the kernel can't
// import this). A fact with a source is an observation; statuses follow the evidence (the backend derives them).
export type GraphStatus = "unverified" | "supported" | "verified" | "contested" | "debunked"
export type GraphTime = number | string // ms since 1970, or an ISO date
export type GraphSummary = {
  readonly id: string; readonly kind: string; readonly text: string; readonly status: GraphStatus; readonly evidence: number; readonly usefulness: number
  readonly valid_from: number | null; readonly valid_until: number | null
}
export type GraphFact = Omit<GraphSummary, "evidence" | "usefulness"> & {
  readonly attrs: Readonly<Record<string, unknown>>; readonly learned_at: number; readonly retired_at: number | null; readonly source: string | null; readonly source_trust: string | null
}
export type GraphAdd = {
  readonly kind: string; readonly text: string; readonly attrs?: Readonly<Record<string, unknown>>; readonly valid_from?: GraphTime | null; readonly valid_until?: GraphTime | null
  readonly source?: string; readonly source_trust?: string; readonly vector?: ReadonlyArray<number>
}
export type GraphLink = { readonly from: string; readonly to: string; readonly type: string; readonly weight?: number; readonly attrs?: Readonly<Record<string, unknown>> }
type GraphAttr = string | number | boolean | null // null matches a missing attribute
type GraphAttrs = Readonly<Record<string, GraphAttr | ReadonlyArray<GraphAttr>>> // an array matches any of its values
export type GraphQuery = {
  readonly text?: string; readonly kind?: string; readonly attrs?: GraphAttrs; readonly status?: GraphStatus | ReadonlyArray<GraphStatus>
  readonly about?: string; readonly at?: GraphTime; readonly includeRetired?: boolean; readonly limit?: number
}
export type GraphWhy = { readonly fact: GraphSummary; readonly evidence: ReadonlyArray<{ readonly type: "supports" | "contradicts"; readonly weight: number; readonly fact: GraphSummary }> }
export type GraphNear = { readonly by: "time" | "vector"; readonly limit?: number; readonly includeRetired?: boolean }
export type GraphMark = { readonly at: number; readonly id: string } // a fact's learned_at, then its id

// A backend refusing what it was asked (a link to no fact, an unknown trust): thrown by GraphOps, and the cause of the
// MemoryError `use` then fails with, so a caller can tell a refusal from the store failing.
export class GraphInvalid extends Error {
  override name = "GraphInvalid"
}

// What one unit of work can do, synchronously, inside GraphMemory.use.
export interface GraphOps {
  readonly now: () => number // the backend's clock (learned_at, retired_at)
  readonly add: (fact: GraphAdd) => GraphFact
  readonly link: (link: GraphLink) => GraphLink & { readonly id: string; readonly weight: number; readonly learned_at: number }
  readonly retire: (id: string) => void
  readonly update: (id: string, changes: { readonly valid_from?: GraphTime | null; readonly valid_until?: GraphTime | null; readonly attrs?: Readonly<Record<string, unknown>>; readonly text?: string }) => GraphFact
  readonly show: (id: string) => GraphFact | null
  readonly query: (q?: GraphQuery) => ReadonlyArray<GraphSummary>
  readonly why: (id: string) => GraphWhy | null
  readonly near: (from: string | ReadonlyArray<number>, options: GraphNear) => ReadonlyArray<GraphSummary>
  readonly reportUsage: (report: { readonly shown?: ReadonlyArray<string>; readonly picked?: ReadonlyArray<string>; readonly outcome?: "good" | "bad" }) => void
  // Facts true now as plain "- " lines: no observations, existence facts or debunked ones (R31: lossy).
  readonly exportMarkdown: (options?: { readonly kinds?: ReadonlyArray<string>; readonly attrs?: GraphAttrs; readonly groupBy?: string }) => string
  // Observations not retired whose source starts with `sourcePrefix`, learned after `after`, oldest first.
  readonly observations: (q: { readonly sourcePrefix: string; readonly after: GraphMark; readonly limit: number }) => ReadonlyArray<GraphFact>
  readonly stats: () => ReadonlyArray<{ readonly kind: string; readonly status: GraphStatus; readonly count: number }> // facts not retired, by kind then status
  readonly meta: { readonly get: (key: string) => unknown; readonly set: (key: string, value: unknown) => void } // JSON values; undefined: never set
}

// Runs f as one transaction on the backend's store (retried while it's busy); f throwing rolls it back.
export type GraphUse = <A>(f: (ops: GraphOps) => A) => Effect.Effect<A, MemoryError>

// One notes file as the graph holds it: its Store key, how the snapshot labels it, and the attributes that pick its facts
// (null: the attribute is missing).
export type NotesFile = { readonly key: string; readonly label: string; readonly scope: Scope; readonly filter: Readonly<Record<string, string | null>> }

export class GraphMemory extends Context.Service<GraphMemory, {
  readonly use: GraphUse // any graph action, atomically (KTD4)
  readonly files: Effect.Effect<ReadonlyArray<NotesFile>> // the ones the active agent sees, in the snapshot's order
  readonly candidates: (goal: string) => Effect.Effect<ReadonlyArray<PullCandidate>> // for the turn-start pull (KTD12)
  readonly exportNotes: Effect.Effect<Readonly<Record<string, string>>> // every notes file, by Store key (R31: lossy)
}>()("empty-vessel/GraphMemory") {}

export const projectOf = (root: string) => basename(projectDir(root, ""))

// The file a fact of `scope` belongs to, for `agent` in `project`.
const notesFile = (scope: Scope, agent: string, project: string): NotesFile =>
  scope === "user" ? { key: PROFILE, label: "Who the user is and how they work", scope, filter: { scope } }
  : scope === "project" ? { key: `projects/${project}/learned.md`, label: "About this project", scope, filter: { scope, project } }
  : agent === "root" ? { key: agentKey("root"), label: "How empty-vessel works with the user", scope, filter: { scope, agent: null } }
  : { key: agentKey(agent), label: `As the ${agent} agent`, scope, filter: { scope, agent } }

// A new fact's attributes: the file's filter without its missing ones.
export const attrsOf = (file: NotesFile): Record<string, string> =>
  Object.fromEntries(Object.entries(file.filter).filter((e): e is [string, string] => e[1] !== null))

// What a reader is shown of the graph: facts true now that aren't observations, existence facts or debunked (as the export).
const shownFact = (f: GraphFact | null): f is GraphFact => !!f && f.source === null && f.attrs.role !== "existence" && f.status !== "debunked"

// The facts true now matching `filter`, oldest first.
// ponytail: query's limit counts the facts it skips here too; a source filter in the query if observations crowd it.
export const factsIn = (ops: GraphOps, filter: GraphAttrs, limit = 1000) =>
  ops.query({ attrs: filter, limit }).map((s) => ops.show(s.id)).filter(shownFact).sort((a, b) => a.learned_at - b.learned_at)

// A fact the user stated (/memory add and edit): backed by a checked observation from the user, so it reads as verified.
export const stated = (ops: GraphOps, text: string, attrs: Readonly<Record<string, unknown>>) => {
  const fact = ops.add({ kind: "note", text, attrs })
  const said = ops.add({ kind: "observation", text, source: "user", source_trust: "checked" })
  ops.link({ from: said.id, to: fact.id, type: "supports" })
  return fact
}

// Once per graph (KTD17): the notes become note facts, each supported by one migration observation. The meta marker is
// checked and written in the same unit of work, so two processes opening an empty graph at once migrate once.
export const migrateNotes = (ops: GraphOps, notes: ReadonlyArray<{ readonly file: NotesFile; readonly lines: ReadonlyArray<string> }>) => {
  if (ops.meta.get(MIGRATED) !== undefined) return 0
  let n = 0

  for (const { file, lines } of notes) {
    for (const line of lines) {
      const text = line.replace(/^- /, "").trim()
      if (!text) continue
      const fact = ops.add({ kind: "note", text, attrs: attrsOf(file) })
      const seen = ops.add({ kind: "observation", text, source: "migration", source_trust: "asserted" })
      ops.link({ from: seen.id, to: fact.id, type: "supports" })
      n++
    }
  }

  ops.meta.set(MIGRATED, ops.now())
  return n
}

// The graph memory for the project at `root`, over a backend's `use` (`open`: made once, for as long as the layer is;
// `where`: what Memory.file shows, relative to the Store).
export const graphMemory = (root: string, where: string, open: Effect.Effect<GraphUse, never, Store | EffectScope.Scope>) => {
  const project = projectOf(root)

  const graph = Layer.effect(GraphMemory, Effect.gen(function* () {
    const store = yield* Store
    const use = yield* open

    // First open: today's notes files, every agent's and every project's (one graph holds them all).
    if (!(yield* use((ops) => ops.meta.get(MIGRATED) !== undefined).pipe(Effect.orDie))) {
      const lines = (key: string) => store.get(key).pipe(Effect.map((t) => (t ?? "").split("\n").filter((l) => l.trim())))
      const agents = (yield* store.list("agents")).map((n) => notesFile("agent", n, project))
      const projects = (yield* store.list("projects")).map((p) => notesFile("project", "root", p))
      const files = [notesFile("user", "root", project), notesFile("agent", "root", project), ...agents, ...projects]
      const notes = yield* Effect.forEach(files, (file) => Effect.map(lines(file.key), (ls) => ({ file, lines: ls })))
      const n = yield* use((ops) => migrateNotes(ops, notes)).pipe(Effect.orDie)
      if (n) yield* Effect.logInfo(`memory: ${n} notes became facts in ${where}; the notes files stay where they are, no longer read`)
    }

    const files = Effect.map(ActiveAgent, (agent) => [
      notesFile("user", "root", project), notesFile("agent", "root", project),
      ...(agent === "root" ? [] : [notesFile("agent", agent, project)]), notesFile("project", agent, project),
    ])

    // KTD12: facts true now the active agent sees, FTS matches on the goal first, then the top ones by status and
    // usefulness while there's room.
    const candidates = (goal: string) => Effect.gen(function* () {
      const agent = yield* ActiveAgent
      const attrs = { agent: agent === "root" ? [null] : [null, agent], project: [null, project] }

      return yield* use((ops) => {
        const out = new Map<string, PullCandidate>()
        const take = (ids: ReadonlyArray<{ readonly id: string }>) => {
          for (const { id } of ids) {
            const f = ops.show(id)
            if (out.size < MAX_CANDIDATES && shownFact(f)) out.set(id, { id, text: f.text, kind: f.kind })
          }
        }
        // Notes only: captured observations far outnumber them and would fill the limit before any note.
        take(ops.query({ kind: "note", text: goal, attrs, limit: MAX_CANDIDATES * 3 }))
        if (out.size < MAX_CANDIDATES) take(ops.query({ kind: "note", attrs, limit: MAX_CANDIDATES * 3 }))
        return [...out.values()]
      })
    }).pipe(Effect.orElseSucceed(() => []))

    const exportNotes = use((ops) => {
      const keys = new Map(factsIn(ops, { scope: SCOPES }).map((f) => {
        const file = notesFile(f.attrs.scope as Scope, (f.attrs.agent as string | undefined) ?? "root", (f.attrs.project as string | undefined) ?? project)
        return [file.key, file] as const
      }))
      return Object.fromEntries([...keys.values()].map((file) => [file.key, ops.exportMarkdown({ attrs: file.filter })]))
    }).pipe(Effect.orDie)

    return { use, files, candidates, exportNotes }
  }))

  // Memory over the graph: a scope's entries are the active agent's own facts of it, one "- " line each. No size limits:
  // the pull, not the briefing, decides what a turn sees.
  const memory = Layer.effect(Memory, Effect.gen(function* () {
    const gm = yield* GraphMemory
    const own = (scope: Scope) => Effect.map(ActiveAgent, (agent) => notesFile(scope, agent, project))
    const entries = (scope: Scope) => Effect.flatMap(own(scope), (file) => gm.use((ops) => factsIn(ops, file.filter).map((f) => `- ${f.text}`))).pipe(Effect.orDie)

    // The one own fact of `scope` containing `old`, ended (replace: valid until now, as a fact that changed) or retired.
    const change = (scope: Scope, old: string, to: string | undefined) => Effect.flatMap(own(scope), (file) => gm.use((ops) => {
      const found = factsIn(ops, file.filter).filter((f) => f.text.includes(old))
      if (found.length !== 1) return `${found.length ? "several" : "no"} ${scope} entries contain "${old}"`
      if (to === undefined) return void ops.retire(found[0]!.id)

      ops.update(found[0]!.id, { valid_until: ops.now() })
      ops.add({ kind: "note", text: to, attrs: found[0]!.attrs })
    })).pipe(Effect.flatMap((refused) => (refused ? Effect.fail(new MemoryError({ message: refused })) : Effect.void)))

    // What the snapshot's other callers (the reviewer, the kernel's remembered()) read: the export of each file the active
    // agent sees, labelled as the notes are. Never the briefing (src/learning/notes.ts).
    const snapshot = Effect.gen(function* () {
      const files = yield* gm.files
      const parts = yield* gm.use((ops) => files.map((f) => ({ label: f.label, text: ops.exportMarkdown({ attrs: f.filter }).trim() })))
      return parts.filter((p) => p.text).map((p) => `${p.label}:\n${p.text}`).join("\n\n")
    }).pipe(Effect.orDie)

    return {
      snapshot,
      add: (scope, text) => Effect.flatMap(own(scope), (file) => gm.use((ops) => void ops.add({ kind: "note", text, attrs: attrsOf(file) }))),
      replace: (scope, old, text) => change(scope, old, text),
      remove: (scope, old) => change(scope, old, undefined),
      entries,
      file: () => Effect.succeed(where),
    }
  }))

  // The pull, and its usage (KTD18): the outcome credited to the picked facts only; a turn left waiting credits nothing.
  const pull = Layer.effect(MemoryPull, Effect.map(GraphMemory, (gm) => ({
    candidates: gm.candidates,
    reportUsage: ({ shown, picked, outcome }) => gm.use((ops) => ops.reportUsage({
      shown, picked, ...(outcome === "done" ? { outcome: "good" } : outcome === "waiting" ? {} : { outcome: "bad" }),
    })).pipe(Effect.ignore),
  })))

  return Layer.mergeAll(memory, pull).pipe(Layer.provideMerge(graph))
}
