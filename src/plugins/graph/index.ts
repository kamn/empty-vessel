import { Effect } from "effect"
import { add, EGraphInvalid, exportMarkdown, type ExportInput, type Fact, type Graph, link, type NearInput, near, open, query, type QueryInput, reportUsage, retire, show, update, why, withRetry } from "empty-graph"
import { type GraphOps, type GraphStatus, GraphInvalid, type GraphUse, graphMemory, MemoryError, type Plugin, Store } from "empty-vessel"

// memory.use = graph: empty-vessel's memory as one empty-graph file in the store, for the project empty-vessel was started
// in. It provides Memory, GraphMemory and the turn-start pull (always on: memory.pull is the notes' switch), as the core's
// graphMemory makes them over this file. The first open turns today's notes into facts. The only part of empty-vessel
// that knows empty-graph: everything else reaches the graph through GraphOps.
export const GRAPH_FILE = "graph.egraph"

// GraphOps as empty-graph's actions, and SQL on its file for what they don't cover (meta, the capture's and curator's reads).
const opsOf = (g: Graph): GraphOps => ({
  now: g.now,
  add: (fact) => add(g, fact),
  link: (l) => link(g, l),
  retire: (id) => retire(g, id),
  update: (id, changes) => update(g, id, changes),
  show: (id) => show(g, id),
  query: (q) => query(g, q as QueryInput),
  why: (id) => why(g, id),
  near: (from, options) => near(g, from, options as NearInput),
  reportUsage: (r) => reportUsage(g, { shown: r.shown && [...r.shown], picked: r.picked && [...r.picked], ...(r.outcome ? { outcome: r.outcome } : {}) }),
  exportMarkdown: (options) => exportMarkdown(g, options as ExportInput),
  observations: ({ sourcePrefix, after, limit }) => {
    const like = `${sourcePrefix.replace(/[\\%_]/g, "\\$&")}%`
    const rows = g.db.query(`SELECT id FROM facts WHERE source LIKE ?1 ESCAPE '\\' AND retired_at IS NULL
      AND (learned_at > ?2 OR (learned_at = ?2 AND id > ?3)) ORDER BY learned_at, id LIMIT ?4`).all(like, after.at, after.id, limit) as Array<{ id: string }>
    return rows.map(({ id }) => show(g, id) as Fact)
  },
  stats: () => (g.db.query("SELECT kind, status, count(*) AS count FROM facts WHERE retired_at IS NULL GROUP BY kind, status ORDER BY kind, status").all() as Array<{ kind: string; status: GraphStatus; count: number }>),
  meta: {
    get: (key) => {
      const row = g.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null
      return row ? JSON.parse(row.value) : undefined
    },
    set: (key, value) => void g.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [key, JSON.stringify(value)]),
  },
})

// The file at the Store's graph.egraph, open for as long as the layer is; each use one immediate transaction, retried
// while another process holds the file.
export const graphOnStore = (root: string) => graphMemory(root, GRAPH_FILE, Effect.gen(function* () {
  const store = yield* Store
  const g = yield* Effect.acquireRelease(Effect.sync(() => open(store.folder(GRAPH_FILE))), (g) => Effect.sync(() => g.close()))
  const ops = opsOf(g)

  const use: GraphUse = (f) => Effect.try({
    try: () => withRetry(() => g.db.transaction(() => f(ops)).immediate()),
    catch: (e) => new MemoryError({ message: e instanceof Error ? e.message : String(e), cause: e instanceof EGraphInvalid ? new GraphInvalid(e.message) : e }),
  })
  return use
}))

export const graph: Plugin = { name: "graph", provides: { memory: Effect.sync(() => graphOnStore(process.cwd())) } }
