import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigSchema } from "../../src/base/config"
import { childConfig } from "../../src/loop/turnkit"

const config = (o: object) => Schema.decodeUnknownSync(ConfigSchema)(o)
const reviewer = (tools: object) => ({ name: "reviewer", description: "", settings: {}, instructions: "Review.", confidence: 0.7, config: config({ systemTwo: { reasoning: "high" }, kernel: { tools } }) })

test("childConfig: an agent's config, its grants narrowed by the parent's and by spawn's own; without an agent, the parent's narrowed", () => {
  const parent = config({})
  const child = childConfig(parent, { agent: reviewer({ files: "read-only" }), tools: { shell: false } })
  expect(child.systemTwo.reasoning).toBe("high")
  expect(child.kernel.tools.files).toBe("read-only")
  expect(child.kernel.tools.shell).toBe(false)

  // An agent can't get more than its parent has
  const readOnly = config({ kernel: { tools: { files: "read-only", agents: true } } })
  expect(childConfig(readOnly, { agent: reviewer({ files: "read-write" }) }).kernel.tools.files).toBe("read-only")

  // No agent: as before
  expect(childConfig(parent, { tools: { shell: false } })).toEqual({ ...parent, kernel: { ...parent.kernel, tools: { ...parent.kernel.tools, shell: false } } })
  expect(childConfig(parent, {})).toEqual(parent)
})

test("the kernel's spawn with an agent that doesn't exist fails the call at once, naming the agents, and starts no job", async () => {
  const { Context, Effect } = await import("effect")
  const { makeHost } = await import("../../src/loop/kernel")
  const { newConversation } = await import("../../src/loop/turnkit")
  const conversation = newConversation()
  const started: Array<unknown> = []
  const ctx = { depth: 0, config: config({}), conversation, spawn: (task: string, options: unknown) => Effect.sync(() => { started.push(options); return task }) }
  const host = makeHost(ctx as never, Context.empty() as never)

  const failed = await Effect.runPromise(Effect.flip(host.spawn!({ task: "review it", agent: "no-such-agent" }) as never))
  expect(String(failed)).toContain('No agent named "no-such-agent"')
  expect(conversation.jobs.list()).toEqual({})
  expect(started).toEqual([])

  // Without an agent: a job, as before
  await Effect.runPromise(host.spawn!({ task: "do it" }) as never)
  expect(Object.keys(conversation.jobs.list())).toHaveLength(1)
})

test("agentsLine: the agents for System Two's first prompt, only when there are some and this agent may still spawn", async () => {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { agentsLine } = await import("../../src/loop/steps")
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-agents-"))
  mkdirSync(join(home, "agents", "reviewer"), { recursive: true })
  writeFileSync(join(home, "agents", "reviewer", "agent.md"), "---\ndescription: Reviews changes without editing them\n---\nReview.")

  expect(agentsLine({ depth: 0, config: config({}) }, home)).toBe("Agents (spawn(task, { agent: name }) runs a sub-agent as one): reviewer — Reviews changes without editing them")
  expect(agentsLine({ depth: 2, config: config({ maxDepth: 2 }) }, home)).toBeUndefined() // too deep to spawn
  expect(agentsLine({ depth: 0, config: config({ kernel: { tools: { agents: false } } }) }, home)).toBeUndefined()
  expect(agentsLine({ depth: 0, config: config({}) }, mkdtempSync(join(tmpdir(), "empty-vessel-agents-")))).toBeUndefined()
})

test("the kernel's spawn with an agent that exists: one job, given the agent with its config, grants narrowed by the parent's", async () => {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-agents-"))
  mkdirSync(join(home, "agents", "reviewer"), { recursive: true })
  writeFileSync(join(home, "agents", "reviewer", "agent.md"), "---\nsystemTwo: { reasoning: high }\nkernel: { tools: { files: read-only } }\n---\nReview.")

  const script = `import { Context, Effect, Schema } from "effect"; import { ConfigSchema } from "./src/base/config"; import { makeHost } from "./src/loop/kernel"; import { childConfig } from "./src/loop/turnkit"; import { newConversation } from "./src/loop/turnkit"
    const config = Schema.decodeUnknownSync(ConfigSchema)({ kernel: { tools: { shell: false } } })
    const conversation = newConversation(), given = []
    const host = makeHost({ depth: 0, config, conversation, spawn: (task, options) => Effect.sync(() => { given.push(options); return task }) }, Context.empty())
    Effect.runPromise(host.spawn({ task: "review it", agent: "reviewer" })).then(() => {
      const child = childConfig(config, given[0])
      console.log([Object.keys(conversation.jobs.list()).length, given[0].agent.name, given[0].agent.instructions, child.systemTwo.reasoning, child.kernel.tools.files, child.kernel.tools.shell].join(" | "))
    })`
  const r = Bun.spawnSync(["bun", "-e", script], { cwd: join(import.meta.dir, "../.."), env: { ...process.env, EMPTY_VESSEL_HOME: home }, stdout: "pipe", stderr: "pipe" })
  expect((r.stdout.toString() + r.stderr.toString()).trim()).toBe("1 | reviewer | Review. | high | read-only | false")
})
