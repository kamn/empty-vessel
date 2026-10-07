import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { AGENTS_GUIDE, applyAgent, DEFAULT_CONFIDENCE, ensureAgentsGuide, listAgents, loadAgent } from "../../src/base/agents"
import { ConfigSchema } from "../../src/base/config"

// A empty-vessel home with these agents: name → agent.md's text.
const home = (agents: Readonly<Record<string, string>>) => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-agents-"))

  for (const [name, text] of Object.entries(agents)) {
    mkdirSync(join(dir, "agents", name), { recursive: true })
    writeFileSync(join(dir, "agents", name, "agent.md"), text)
  }

  return dir
}

const REVIEWER = `---
description: Reviews changes without editing them
systemTwo: { reasoning: high }
plugins: { codex: { config: { model: gpt-big } } }
kernel: { tools: { files: read-only } }
---
You review changes. Find bugs; don't fix them.
`
const parent = Schema.decodeUnknownSync(ConfigSchema)({ systemTwo: { use: "codex" }, plugins: { codex: { config: { model: "gpt-small", fillModel: "gpt-fill" } } } })
const failure = <A, E extends { message: string }>(e: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(e)).then((x) => x.message)

test("loadAgent: description, settings and instructions; applyAgent merges deeply over the parent's config", async () => {
  const dir = home({ reviewer: REVIEWER, notes: "Just instructions, no front matter." })
  const agent = await Effect.runPromise(loadAgent("reviewer", dir))
  expect(agent.description).toBe("Reviews changes without editing them")
  expect(agent.instructions).toBe("You review changes. Find bugs; don't fix them.")

  const config = await Effect.runPromise(applyAgent(parent, agent))
  expect(config.systemTwo.reasoning).toBe("high")
  expect(config.systemTwo.use).toBe("codex") // the parent's, kept
  expect(config.plugins.codex?.config).toEqual({ model: "gpt-big", fillModel: "gpt-fill" }) // one setting changed, the rest kept
  expect(config.kernel.tools.files).toBe("read-only")

  const plain = await Effect.runPromise(loadAgent("notes", dir))
  expect(plain.settings).toEqual({})
  expect(plain.instructions).toBe("Just instructions, no front matter.")
  expect(listAgents(dir)).toEqual([{ name: "notes", description: "" }, { name: "reviewer", description: "Reviews changes without editing them" }])
})

test("loadAgent and applyAgent refuse what an agent can't set, and say which agents there are", async () => {
  const dir = home({
    reviewer: REVIEWER,
    pilot: "---\nsystemOne: { use: fake }\n---\nx",
    grantor: "---\nkernel: { sources: false }\n---\nx",
    loud: "---\nsystemTwo: { reasoning: extreme }\n---\nx",
    loader: "---\nplugins: { evil: { path: /tmp/evil.js, enabled: true } }\n---\nx", // would load code into empty-vessel itself
  })
  expect(await failure(loadAgent("loader", dir))).toContain("plugins.evil.path")
  expect(await failure(loadAgent("pilot", dir))).toContain("systemOne")
  expect(await failure(loadAgent("grantor", dir))).toContain("kernel.sources")
  expect(await failure(loadAgent("nobody", dir))).toContain("reviewer")
  expect(await failure(loadAgent("../reviewer", dir))).toContain("reviewer")

  const loud = await Effect.runPromise(loadAgent("loud", dir))
  expect(await failure(applyAgent(parent, loud))).toContain("reasoning")
  expect(listAgents(mkdtempSync(join(tmpdir(), "empty-vessel-agents-")))).toEqual([])

  // A folder loadAgent would refuse by name isn't offered either
  const odd = home({ reviewer: REVIEWER, "two words": "x" })
  expect(listAgents(odd).map((a) => a.name)).toEqual(["reviewer"])
})

test("the guide: written once into the agents folder, never over yours; every example agent in it loads and applies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-agents-"))
  ensureAgentsGuide(dir)
  expect(readFileSync(join(dir, "agents", "README.md"), "utf8")).toBe(AGENTS_GUIDE)
  writeFileSync(join(dir, "agents", "README.md"), "mine")
  ensureAgentsGuide(dir)
  expect(readFileSync(join(dir, "agents", "README.md"), "utf8")).toBe("mine")
  expect(listAgents(dir)).toEqual([]) // the guide isn't an agent

  // Each ```markdown example is a whole agent.md
  const examples = [...AGENTS_GUIDE.matchAll(/```markdown\n([\s\S]*?)```/g)].map((m) => m[1]!)
  expect(examples.length).toBeGreaterThanOrEqual(2)
  const homeWith = home(Object.fromEntries(examples.map((e, i) => [`example${i}`, e])))

  for (const name of examples.map((_, i) => `example${i}`)) {
    const agent = await Effect.runPromise(loadAgent(name, homeWith))
    expect(agent.description).not.toBe("")
    await Effect.runPromise(applyAgent(parent, agent))
  }
})

test("confidence: how sure System One must be to pick an agent, 0 to 1; none given is the default; not a config setting", async () => {
  const dir = home({ sure: "---\ndescription: d\nconfidence: 0.9\n---\nx", plain: "---\ndescription: d\n---\nx", wild: "---\nconfidence: 2\n---\nx" })
  const sure = await Effect.runPromise(loadAgent("sure", dir))
  expect(sure.confidence).toBe(0.9)
  expect(sure.settings).toEqual({}) // not merged into the config
  expect((await Effect.runPromise(loadAgent("plain", dir))).confidence).toBe(DEFAULT_CONFIDENCE)
  expect(await failure(loadAgent("wild", dir))).toContain("confidence")
})
