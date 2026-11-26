import { Effect } from "effect"
import { graphOnStore, type Plugin } from "empty-vessel"

// memory.use = graph: empty-vessel's memory as one empty-graph file in the store (src/base/graph-memory.ts), for the
// project empty-vessel was started in. It provides Memory, GraphMemory and the turn-start pull (always on: memory.pull is
// the notes' switch). The first open turns today's notes into facts.
export const graph: Plugin = { name: "graph", provides: { memory: Effect.sync(() => graphOnStore(process.cwd())) } }
