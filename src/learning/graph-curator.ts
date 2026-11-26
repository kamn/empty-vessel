import { Effect, Schema } from "effect"
import { add, type Fact, type Graph, link, query, show, update } from "empty-graph"
import { GraphMemory } from "../base/graph-memory"
import { Reviewer } from "./reviewer"

// The curator (KTD15, R24, R25): the Reviewer (the model curateMemory uses) is shown the observations captured since the
// last curation (src/learning/graph-capture.ts) and the facts they may bear on, and answers with graph operations: add a
// fact resting on observations, link observations to a fact as supporting or contradicting it, or retire a fact that
// stopped being true (it gets a valid-until time, the time of the evidence, so it stays true for earlier times: AE1).
// Statuses follow the evidence (empty-graph derives them). Refused operations go back to it once with the reasons.
// The guard keys on scope, not kind (R26): a fact with attrs.scope = user is created, supported, contradicted or retired
// only on evidence that is all from the user's own turns (origin user); a job's or a sub-agent's words never are.
const CURATED = "empty-vessel.curated" // meta key: { at, id } of the last observation curated (learned_at, then id)
const BATCH = 60
// ponytail: a backlog (a first run over months of sessions) drains a few batches per run; a bigger cap if it lags.
const MAX_BATCHES = 5

const GraphOp = Schema.Struct({
  op: Schema.Literals(["add", "link", "retire"]),
  text: Schema.String,
  scope: Schema.NullOr(Schema.Literals(["project", "agent", "user"])),
  fact: Schema.NullOr(Schema.String),
  type: Schema.NullOr(Schema.Literals(["supports", "contradicts"])),
  evidence: Schema.Array(Schema.String),
})
export const GraphOps = Schema.Struct({ ops: Schema.Array(GraphOp) })
type GraphOp = typeof GraphOp.Type

const INSTRUCTIONS = [
  "You curate the knowledge graph of a coding agent (empty-vessel): facts it is handed before each turn, each resting on observations of what its sessions did (turns, commands, checks, file changes).",
  "You're shown new observations, each with its id, kind and attributes (origin: who started that turn: user, or a scheduled job such as cron; project; agent), and the facts now that may relate to them, each with its id, scope and status.",
  "Keep only what would help a later, different task: how this project is set up and run (scope project), this computer and its tools (scope agent), who the user is and how they work (scope user, never machine facts). Not what one task did.",
  "Operations, every field present: add: text is the new fact, one sentence, with its scope; fact and type null. link: fact is an existing fact's id, type supports or contradicts; text empty, scope null. retire: fact is the id of a fact that stopped being true (the project changed); text empty, scope and type null. Every operation lists in evidence the ids of the observations it rests on (at least one).",
  "Prefer linking new evidence to a fact that's there over adding a near-duplicate. When something changed (tests moved from npm test to bun test), retire the old fact and add the new one, both on the observation that shows the change.",
  "Facts about the user come only from the user's own turns (origin user): a scheduled job's words are never evidence about the user.",
  "Changing nothing is a fine answer: an empty list.",
].join("\n")

const refuse = (why: string): never => { throw new Error(why) }
const timeOf = (f: Fact) => f.valid_from ?? f.learned_at

// One operation, applied in one transaction: what it did, or an Error saying why not.
const apply = (g: Graph, o: GraphOp) => g.db.transaction(() => {
  const evidence = o.evidence.map((id) => show(g, id))
  if (!evidence.length) refuse("no evidence: list the observations it rests on")
  const observed = evidence.map((f, i) => (f && f.source !== null ? f : refuse(`${o.evidence[i]} is not an observation`)))
  const fromUser = observed.every((f) => f.attrs.origin === "user")
  const guard = "facts about the user change only on evidence from the user's own turns (origin user)"

  if (o.op === "add") {
    if (!o.scope || !o.text.trim()) refuse("an add needs text and a scope")
    if (o.scope === "user" && !fromUser) refuse(guard)
    const { project, agent } = observed[0]!.attrs
    const attrs = { scope: o.scope, ...(o.scope === "project" && project ? { project } : {}), ...(o.scope === "agent" && agent ? { agent } : {}) }
    const fact = add(g, { kind: "note", text: o.text, attrs, valid_from: Math.min(...observed.map(timeOf)) })
    for (const e of observed) link(g, { from: e.id, to: fact.id, type: "supports" })
    return `added (${o.scope}): ${o.text}`
  }

  const target = o.fact ? show(g, o.fact) : null
  if (!target || target.source !== null) refuse(`no fact ${o.fact}`)
  if (target!.attrs.scope === "user" && !fromUser) refuse(guard)

  if (o.op === "link") {
    const type = o.type ?? refuse("a link needs a type: supports or contradicts")
    for (const e of observed) link(g, { from: e.id, to: target!.id, type })
    return `linked (${type}): ${target!.text}`
  }

  // Valid until the change: evidence dated from then on doesn't count against it (empty-graph, AE6).
  const until = Math.max(...observed.map(timeOf))
  if (target!.valid_from !== null && until < target!.valid_from) refuse("the evidence is older than the fact")
  update(g, target!.id, { valid_until: until })
  for (const e of observed) link(g, { from: e.id, to: target!.id, type: "contradicts" })
  return `retired: ${target!.text}`
}).immediate()

type Mark = { at: number; id: string }

// The next batch of captured observations not yet curated, oldest first, and the facts true now they may bear on.
const uncurated = (g: Graph) => {
  const row = g.db.query("SELECT value FROM meta WHERE key = ?").get(CURATED) as { value: string } | null
  const mark: Mark = row ? JSON.parse(row.value) : { at: -1, id: "" }
  const ids = g.db.query(`SELECT id FROM facts WHERE source LIKE 'session:%' AND retired_at IS NULL
    AND (learned_at > ?1 OR (learned_at = ?1 AND id > ?2)) ORDER BY learned_at, id LIMIT ?3`).all(mark.at, mark.id, BATCH) as Array<{ id: string }>
  return ids.map(({ id }) => show(g, id)!)
}
const related = (g: Graph, observations: ReadonlyArray<Fact>) =>
  query(g, { kind: "note", text: observations.map((o) => o.text).join(" "), limit: 40 }).map((s) => show(g, s.id)!)
const markAt = (g: Graph, last: Fact) => g.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [CURATED, JSON.stringify({ at: last.learned_at, id: last.id })])

const describe = (f: Fact) => `- ${f.id} [${Object.entries(f.source === null ? { scope: f.attrs.scope ?? "none", status: f.status } : { kind: f.kind, ...f.attrs }).map(([k, v]) => k === "kind" ? v : `${k}: ${v}`).join(", ")}] ${f.text}`

// Curate what was captured since the last run (`window`: what prompted it, from a memory nudge). Gives what happened to
// each operation, one line each. Called by `empty-vessel graph curate`, the nudge review with the graph on, and the
// agent's scheduled curate job.
export const curateGraph = (window?: string) =>
  Effect.gen(function* () {
    const reviewer = yield* Reviewer
    const gm = yield* GraphMemory
    const said: Array<string> = []

    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const observations = yield* gm.use(uncurated)
      if (!observations.length) break
      let refused: Array<string> = []

      for (let round = 0; round < 2 && (round === 0 || refused.length > 0); round++) {
        const facts = yield* gm.use((g) => related(g, observations))
        const digest = [`New observations:\n${observations.map(describe).join("\n")}`,
          `Facts now that may relate:\n${facts.map(describe).join("\n") || "(none yet)"}`,
          ...(window ? [window] : []),
          ...(refused.length ? [`These operations were refused; change the graph as it is now instead:\n${refused.join("\n")}`] : [])].join("\n\n")
        const { value } = yield* reviewer.ask(INSTRUCTIONS, GraphOps, digest)

        refused = []
        for (const o of value.ops) {
          const done = yield* gm.use((g) => apply(g, o)).pipe(Effect.map((s) => ({ s })), Effect.catch((e) => Effect.succeed({ error: e.message })))
          if ("s" in done) said.push(done.s)
          else {
            refused.push(`- ${o.op} ${o.fact ?? o.text} on ${o.evidence.join(", ") || "nothing"}: ${done.error}`)
            said.push(`not done (${done.error}): ${o.op} ${o.fact ?? o.text}`)
          }
        }
      }

      yield* gm.use((g) => markAt(g, observations.at(-1)!))
    }

    return said
  })
