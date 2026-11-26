import { basename } from "node:path"
import { Context, Effect, Layer } from "effect"
import { add, type Attrs, exportMarkdown, type Fact, type Graph, link, open, query, reportUsage, retire, show, update } from "empty-graph"
import { ActiveAgent, agentKey, Memory, MemoryError, MemoryPull, PROFILE, type PullCandidate, type Scope, SCOPES } from "./memory"
import { projectDir } from "./project"
import { Store } from "./store"

// empty-vessel's memory as one empty-graph file for every project (KTD11): what the notes keep per scope, as facts of kind
// "note" with attributes saying whose they are: scope (user, agent, project), agent (a named agent; none for empty-vessel
// itself) and project (none for the user or this machine). A named agent sees its own facts plus the shared ones (R20).
// The Memory service still works over it (the reviewer, the kernel's memory built-in); GraphMemory is the graph itself,
// for code that reads it as optional (Effect.serviceOption): the notes plugin keeps working without it.
export const GRAPH_FILE = "graph.egraph"
const MIGRATED = "empty-vessel.notes_migrated" // a meta key: when the notes became facts (KTD17)
const MAX_CANDIDATES = 40 // as src/loop/pull.ts shows System One

// One notes file as the graph holds it: its Store key, how the snapshot labels it, and the attributes that pick its facts
// (null: the attribute is missing).
export type NotesFile = { readonly key: string; readonly label: string; readonly scope: Scope; readonly filter: Readonly<Record<string, string | null>> }

export class GraphMemory extends Context.Service<GraphMemory, {
  readonly use: <A>(f: (graph: Graph) => A) => Effect.Effect<A, MemoryError> // any empty-graph action on the open file (KTD4)
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
export const attrsOf = (file: NotesFile): Attrs => Object.fromEntries(Object.entries(file.filter).filter(([, v]) => v !== null))

// What a reader is shown of the graph: facts true now that aren't observations, existence facts or debunked (as the export).
const shownFact = (f: Fact | null): f is Fact => !!f && f.source === null && f.attrs.role !== "existence" && f.status !== "debunked"

// The facts true now matching `filter`, oldest first.
// ponytail: query's limit counts the facts it skips here too; a source filter in empty-graph's query if observations crowd it.
export const factsIn = (g: Graph, filter: NotesFile["filter"] | Readonly<Record<string, ReadonlyArray<string | null>>>, limit = 1000) =>
  query(g, { attrs: filter as Record<string, string | null>, limit }).map((s) => show(g, s.id)).filter(shownFact).sort((a, b) => a.learned_at - b.learned_at)

// A fact the user stated (/memory add and edit): backed by a checked observation from the user, so it reads as verified.
export const stated = (g: Graph, text: string, attrs: Attrs) => g.db.transaction(() => {
  const fact = add(g, { kind: "note", text, attrs })
  const said = add(g, { kind: "observation", text, source: "user", source_trust: "checked" })
  link(g, { from: said.id, to: fact.id, type: "supports" })
  return fact
}).immediate()

// Once per graph file (KTD17): the notes become note facts, each supported by one migration observation. The meta marker
// is checked and written in the same immediate transaction, so two processes opening an empty graph at once migrate once.
export const migrateNotes = (g: Graph, notes: ReadonlyArray<{ readonly file: NotesFile; readonly lines: ReadonlyArray<string> }>) =>
  g.db.transaction(() => {
    if (g.db.query("SELECT 1 FROM meta WHERE key = ?").get(MIGRATED)) return 0
    let n = 0

    for (const { file, lines } of notes) {
      for (const line of lines) {
        const text = line.replace(/^- /, "").trim()
        if (!text) continue
        const fact = add(g, { kind: "note", text, attrs: attrsOf(file) })
        const seen = add(g, { kind: "observation", text, source: "migration", source_trust: "asserted" })
        link(g, { from: seen.id, to: fact.id, type: "supports" })
        n++
      }
    }

    g.db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [MIGRATED, JSON.stringify(g.now())])
    return n
  }).immediate()

const failed = (e: unknown) => new MemoryError({ message: e instanceof Error ? e.message : String(e) })

// The graph memory for the project at `root`: the file at the Store's graph.egraph, open for as long as the layer is.
export const graphOnStore = (root: string) => {
  const project = projectOf(root)

  const graph = Layer.effect(GraphMemory, Effect.gen(function* () {
    const store = yield* Store
    const g = yield* Effect.acquireRelease(Effect.sync(() => open(store.folder(GRAPH_FILE))), (g) => Effect.sync(() => g.close()))
    const use = <A>(f: (graph: Graph) => A) => Effect.try({ try: () => f(g), catch: failed })

    // First open: today's notes files, every agent's and every project's (one graph holds them all).
    if (!g.db.query("SELECT 1 FROM meta WHERE key = ?").get(MIGRATED)) {
      const lines = (key: string) => store.get(key).pipe(Effect.map((t) => (t ?? "").split("\n").filter((l) => l.trim())))
      const agents = (yield* store.list("agents")).map((n) => notesFile("agent", n, project))
      const projects = (yield* store.list("projects")).map((p) => notesFile("project", "root", p))
      const files = [notesFile("user", "root", project), notesFile("agent", "root", project), ...agents, ...projects]
      const notes = yield* Effect.forEach(files, (file) => Effect.map(lines(file.key), (ls) => ({ file, lines: ls })))
      const n = yield* use((g) => migrateNotes(g, notes)).pipe(Effect.orDie)
      if (n) yield* Effect.logInfo(`memory: ${n} notes became facts in ${GRAPH_FILE}; the notes files stay where they are, no longer read`)
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

      return yield* use((g) => {
        const out = new Map<string, PullCandidate>()
        const take = (ids: ReadonlyArray<{ readonly id: string }>) => {
          for (const { id } of ids) {
            const f = show(g, id)
            if (out.size < MAX_CANDIDATES && shownFact(f)) out.set(id, { id, text: f.text, kind: f.kind })
          }
        }
        // Notes only: captured observations far outnumber them and would fill the limit before any note.
        take(query(g, { kind: "note", text: goal, attrs, limit: MAX_CANDIDATES * 3 }))
        if (out.size < MAX_CANDIDATES) take(query(g, { kind: "note", attrs, limit: MAX_CANDIDATES * 3 }))
        return [...out.values()]
      })
    }).pipe(Effect.orElseSucceed(() => []))

    const exportNotes = use((g) => {
      const keys = new Map(factsIn(g, { scope: SCOPES }).map((f) => {
        const file = notesFile(f.attrs.scope as Scope, (f.attrs.agent as string | undefined) ?? "root", (f.attrs.project as string | undefined) ?? project)
        return [file.key, file] as const
      }))
      return Object.fromEntries([...keys.values()].map((file) => [file.key, exportMarkdown(g, { attrs: file.filter })]))
    }).pipe(Effect.orDie)

    return { use, files, candidates, exportNotes }
  }))

  // Memory over the graph: a scope's entries are the active agent's own facts of it, one "- " line each. No size limits:
  // the pull, not the briefing, decides what a turn sees.
  const memory = Layer.effect(Memory, Effect.gen(function* () {
    const gm = yield* GraphMemory
    const own = (scope: Scope) => Effect.map(ActiveAgent, (agent) => notesFile(scope, agent, project))
    const entries = (scope: Scope) => Effect.flatMap(own(scope), (file) => gm.use((g) => factsIn(g, file.filter).map((f) => `- ${f.text}`))).pipe(Effect.orDie)

    // The one own fact of `scope` containing `old`, ended (replace: valid until now, as a fact that changed) or retired.
    const change = (scope: Scope, old: string, to: string | undefined) => Effect.flatMap(own(scope), (file) => gm.use((g) => {
      const found = factsIn(g, file.filter).filter((f) => f.text.includes(old))
      if (found.length !== 1) return `${found.length ? "several" : "no"} ${scope} entries contain "${old}"`
      if (to === undefined) return void retire(g, found[0]!.id)

      g.db.transaction(() => {
        update(g, found[0]!.id, { valid_until: g.now() })
        add(g, { kind: "note", text: to, attrs: found[0]!.attrs })
      }).immediate()
    })).pipe(Effect.flatMap((refused) => (refused ? Effect.fail(new MemoryError({ message: refused })) : Effect.void)))

    // What the snapshot's other callers (the reviewer, the kernel's remembered()) read: the export of each file the active
    // agent sees, labelled as the notes are. Never the briefing (src/learning/notes.ts).
    const snapshot = Effect.gen(function* () {
      const files = yield* gm.files
      const parts = yield* gm.use((g) => files.map((f) => ({ label: f.label, text: exportMarkdown(g, { attrs: f.filter }).trim() })))
      return parts.filter((p) => p.text).map((p) => `${p.label}:\n${p.text}`).join("\n\n")
    }).pipe(Effect.orDie)

    return {
      snapshot,
      add: (scope, text) => Effect.flatMap(own(scope), (file) => gm.use((g) => void add(g, { kind: "note", text, attrs: attrsOf(file) }))),
      replace: (scope, old, text) => change(scope, old, text),
      remove: (scope, old) => change(scope, old, undefined),
      entries,
      file: () => Effect.succeed(GRAPH_FILE),
    }
  }))

  // The pull, and its usage (KTD18): the outcome credited to the picked facts only; a turn left waiting credits nothing.
  const pull = Layer.effect(MemoryPull, Effect.map(GraphMemory, (gm) => ({
    candidates: gm.candidates,
    reportUsage: ({ shown, picked, outcome }) => gm.use((g) => reportUsage(g, {
      shown: [...shown], picked: [...picked], ...(outcome === "done" ? { outcome: "good" } : outcome === "waiting" ? {} : { outcome: "bad" }),
    })).pipe(Effect.ignore),
  })))

  return Layer.mergeAll(memory, pull).pipe(Layer.provideMerge(graph))
}
