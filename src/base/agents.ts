import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Data, Effect, Schema } from "effect"
import { ConfigSchema } from "./config"
import { EMPTY_VESSEL_HOME } from "./home"

// Agents: a named context a sub-agent can work in, ~/.empty-vessel/agents/<name>/agent.md. Its front
// matter is a config overlay (System Two's backend and settings, a plugin's settings, the kernel's grants); its body is
// instructions System Two gets after the project's. spawn(task, { agent }) runs a child as one.

export class AgentError extends Data.TaggedError("AgentError")<{ message: string }> {}

export type Agent = {
  readonly name: string
  readonly description: string
  readonly settings: Readonly<Record<string, unknown>> // the overlay: systemTwo, plugins, kernel.tools
  readonly instructions: string
  readonly confidence: number // how sure System One must be to pick it for a conversation (src/answer.ts, pickAgent)
}

// How sure System One must be, when an agent doesn't say. ponytail: one guess; agents.md says it should depend on how
// distinct the agents' descriptions are: tune from logged picks.
export const DEFAULT_CONFIDENCE = 0.7

// What an agent may set: the rest of the config is the parent's. kernel only for its tools (grants only narrow: spawn);
// a plugin only its settings (`config`), never `path` or `enabled`, which load code into empty-vessel itself.
const ALLOWED = ["description", "confidence", "systemTwo", "plugins", "kernel"]
const NAME = /^[\w-]+$/ // an agent's name: a folder, never a path ("root" is empty-vessel itself: never an agent's)

export const agentsDir = (home = EMPTY_VESSEL_HOME) => join(home, "agents")

const read = (name: string, home: string) => {
  const text = readFileSync(join(agentsDir(home), name, "agent.md"), "utf8")
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  const fields = (front ? Bun.YAML.parse(front[1]!) ?? {} : {}) as Record<string, unknown>
  return { fields, instructions: (front ? text.slice(front[0].length) : text).trim() }
}

// The agents there are, by name, with what each is for.
export const listAgents = (home = EMPTY_VESSEL_HOME): ReadonlyArray<{ name: string; description: string }> => {
  const dir = agentsDir(home)
  if (!existsSync(dir)) return []

  try {
    return readdirSync(dir).filter((name) => NAME.test(name) && name !== "root" && existsSync(join(dir, name, "agent.md"))).sort().map((name) => {
      try { return { name, description: String(read(name, home).fields.description ?? "") } } catch { return { name, description: "" } }
    })
  } catch { return [] } // an unreadable folder must never stop a turn (it's read for System Two's first prompt)
}

const known = (home: string) => `Agents: ${listAgents(home).map((a) => a.name).join(", ") || `none (make one: ${agentsDir(home)}/<name>/agent.md)`}`

// One agent, checked: a name (no paths), front matter that parses and sets only what an agent may.
export const loadAgent = (name: string, home = EMPTY_VESSEL_HOME) =>
  Effect.gen(function* () {
    if (!NAME.test(name) || name === "root" || !existsSync(join(agentsDir(home), name, "agent.md"))) return yield* new AgentError({ message: `No agent named "${name}". ${known(home)}` })
    const { fields, instructions } = yield* Effect.try({ try: () => read(name, home), catch: (e) => new AgentError({ message: `agent ${name}: ${e}` }) })

    const plugins = Object.entries((fields.plugins ?? {}) as Record<string, object>).flatMap(([p, v]) => Object.keys(v ?? {}).filter((k) => k !== "config").map((k) => `plugins.${p}.${k}`))
    const extra = [...Object.keys(fields).filter((k) => !ALLOWED.includes(k)), ...Object.keys((fields.kernel ?? {}) as object).filter((k) => k !== "tools").map((k) => `kernel.${k}`), ...plugins]
    if (extra.length) return yield* new AgentError({ message: `agent ${name} sets what an agent can't: ${extra.join(", ")} (only systemTwo, plugins.<name>.config, kernel.tools, description, confidence)` })

    const { description, confidence = DEFAULT_CONFIDENCE, ...settings } = fields
    if (typeof confidence !== "number" || confidence < 0 || confidence > 1) return yield* new AgentError({ message: `agent ${name}: confidence must be a number from 0 to 1 (got ${JSON.stringify(confidence)})` })
    return { name, description: String(description ?? ""), settings, instructions, confidence } satisfies Agent
  })

// Plain objects merge key by key (the agent's values win); anything else replaces.
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const merge = (base: unknown, over: unknown): unknown =>
  isObject(base) && isObject(over) ? Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(over)])].map((k) => [k, k in over ? merge(base[k], over[k]) : base[k]])) : over

// The config a child works with as this agent: the agent's settings over the parent's, checked by the config's own schema.
export const applyAgent = (config: typeof ConfigSchema.Type, agent: Agent) =>
  Schema.decodeUnknownEffect(ConfigSchema)(merge(config, agent.settings)).pipe(Effect.mapError((e) => new AgentError({ message: `agent ${agent.name}: ${e.message}` })))

// The guide in the agents folder: what an agent is and how to write one, with examples to
// copy. Written when missing, never over yours. System Two is pointed at it when asked to make an agent.
export const AGENTS_GUIDE = `# Agents

An agent is a named context empty-vessel can work in: its own instructions, System Two (backend, model, reasoning) and
kernel grants. Each is a folder here with an \`agent.md\`: YAML front matter for its settings, then its instructions.

At the start of a conversation, System One picks the agent that fits your first message (or none: empty-vessel as itself);
\`/agent <name>\` before the first message picks one yourself. From a kernel cell, \`spawn(task, { agent: "name" })\`
runs a sub-agent as one. \`empty-vessel doctor\` checks every agent here.

## What an agent.md may set

- \`description\`: one line on what it's for. System One reads it to pick an agent for a conversation, so make it specific.
- \`confidence\`: how sure System One must be to pick this agent (0 to 1; default 0.7). Below it, empty-vessel works as itself.
- \`systemTwo\`: \`use\` (codex, claude, openai…), \`reasoning\` (low, medium, high, xhigh, max), \`maxRounds\`, \`webSearch\`.
- \`plugins\`: a plugin's settings only, as \`plugins: { <plugin>: { config: { … } } }\` (e.g. its \`model\`).
- \`kernel.tools\`: the kernel's grants. They only ever narrow: an agent never gets more than whoever starts it.

Anything else is refused, by name. The rest of the config is the one empty-vessel runs with.

## Examples

A reviewer: reads and reports, doesn't edit, thinks harder.

\`\`\`markdown
---
description: Reviews a change for bugs and says where; never edits files
systemTwo: { reasoning: high }
kernel: { tools: { files: read-only } }
---
You review changes. Read the diff and the code around it, run the tests if there are any, and report each problem
you find with its file and line, most serious first. Don't fix anything.
\`\`\`

A researcher: reads and searches, writes only notes.

\`\`\`markdown
---
description: Researches a question in the code and on the web; answers with sources
systemTwo: { webSearch: true }
kernel: { tools: { shell: false } }
---
You research. Answer the question with what you found and where (file paths, links). Say what you couldn't confirm.
\`\`\`
`

export const ensureAgentsGuide = (home = EMPTY_VESSEL_HOME) => {
  const file = join(agentsDir(home), "README.md")
  if (existsSync(file)) return

  mkdirSync(agentsDir(home), { recursive: true })
  writeFileSync(file, AGENTS_GUIDE)
}
