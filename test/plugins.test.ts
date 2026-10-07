import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// A script run in a fresh bun, from the repo, with this folder as empty-vessel's home: what it printed.
const runScript = (home: string, script: string) => {
  const r = Bun.spawnSync(["bun", "-e", script], { cwd: join(import.meta.dir, ".."), env: { ...process.env, EMPTY_VESSEL_HOME: home, EMPTY_VESSEL_SYSTEM_TWO: "" }, stdout: "pipe", stderr: "pipe" })
  return (r.stdout.toString() + r.stderr.toString()).trim()
}

// A name is a plugin's identity: the config chooses by it and its settings live under it (plugins.<name>.config).
test("no two plugins share a name", async () => {
  const { PLUGINS } = await import("../src/plugins/index")
  const names = PLUGINS.map((p) => p.name)
  expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([])
})

// The config chooses each kind by a plugin's name; a name no plugin provides for that kind says which ones do.
test("each kind is made by the plugin the config names; an unknown name lists the plugins that provide that kind", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-plugins-"))
  const run = (config: object) => {
    writeFileSync(join(dir, "config.json"), JSON.stringify(config))
    const script = `import { Effect, Layer } from "effect"; import { Config } from "./src/base/config"; import { describeSystemTwo, StoreAndMemoryFromConfig } from "./src/plugins/index"
      Effect.runPromise(Effect.gen(function* () { yield* Layer.build(StoreAndMemoryFromConfig); return (yield* describeSystemTwo).long }).pipe(Effect.scoped, Effect.provide(Config.layer), Effect.catch((e) => Effect.succeed("error: " + e.message)))).then(console.log)`
    return runScript(dir, script)
  }

  expect(run({ systemTwo: { use: "fake" } })).toBe("fake") // store and memory: the defaults (disk, notes)
  expect(run({ systemTwo: { use: "bogus" } })).toBe('error: systemTwo.use is "bogus", but no plugin provides a systemTwo by that name (there are: fake, codex, claude, openai)')
  expect(run({ systemTwo: { use: "fake" }, memory: { use: "disk" } })).toBe('error: memory.use is "disk", but no plugin provides a memory by that name (there are: notes)')
})

// plugins.<name>.from: a copy of a bundled plugin under that name, with that section's config; a plugin that can't be
// copied, or a bundled plugin's name, is an error naming why.
test("a section with from is a copy of that plugin, with its own config; a bad from or a bundled name fails, saying why", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-plugins-"))
  const run = (use: string, plugins: object) => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ systemTwo: { use }, plugins }))
    const script = `import { Effect } from "effect"; import { Config } from "./src/base/config"; import { describeSystemTwo } from "./src/plugins/index"
      Effect.runPromise(describeSystemTwo.pipe(Effect.map((d) => d.long), Effect.provide(Config.layer), Effect.catch((e) => Effect.succeed("error: " + e.message)))).then(console.log)`
    return runScript(dir, script)
  }
  const openai = { config: { baseUrl: "http://a/v1", model: "a" } }

  expect(run("local", { openai, local: { from: "openai", config: { baseUrl: "http://b/v1", model: "b" } } })).toBe("local (b at http://b/v1)")
  expect(run("openai", { openai, local: { from: "openai", config: { baseUrl: "http://b/v1", model: "b" } } })).toBe("openai (a at http://a/v1)")
  expect(run("local:c", { local: { from: "openai", config: { baseUrl: "http://b/v1", model: "b" } } })).toBe("local (c at http://b/v1)") // plugin:model
  expect(run("bogus:c", {})).toContain('error: systemTwo.use is "bogus:c", but no plugin provides a systemTwo by that name')
  expect(run("local", { local: { from: "codex" } })).toBe(`error: systemTwo.use is "local", a plugin that didn't load: from is "codex", but only openai can be copied`)
  expect(run("codex", { codex: { from: "openai" } })).toBe(`error: systemTwo.use is "codex", a plugin that didn't load: codex is a bundled plugin's name`)
})

// /model builds another plugin's System Two (and what goes with it) on top of the config; an unknown one fails, listing them.
test("systemTwoServices: another plugin's System Two, with a Config naming it; an unknown name fails, listing the plugins", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-plugins-"))
  writeFileSync(join(dir, "config.json"), JSON.stringify({ systemTwo: { use: "codex" } }))
  const run = (name: string) => {
    const script = `import { Context, Effect } from "effect"; import { Config } from "./src/base/config"; import { systemTwoServices } from "./src/loop/systems"; import { SystemTwo } from "./src/system-two/systemtwo"
      Effect.runPromise(Effect.gen(function* () { const config = yield* Config; const { services, describe } = yield* systemTwoServices({ ...config, systemTwo: { ...config.systemTwo, use: ${JSON.stringify(name)} } }); const two = Context.get(services, SystemTwo); return [Context.get(services, Config).systemTwo.use, describe.short, (yield* two.ask("hi")).text].join(" | ") }).pipe(Effect.scoped, Effect.provide(Config.layer), Effect.catch((e) => Effect.succeed("error: " + e.message)))).then(console.log)`
    return runScript(dir, script)
  }

  expect(run("fake")).toBe('fake | fake | (System Two would think about: "hi")')
  expect(run("bogus")).toBe('error: systemTwo.use is "bogus", but no plugin provides a systemTwo by that name (there are: fake, codex, claude, openai)')
})

// /model plugin:model: that plugin, its model setting replaced for the session (the rest of its config kept).
test("systemTwoServices with plugin:model: the plugin's System Two on that model", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-plugins-"))
  writeFileSync(join(dir, "config.json"), JSON.stringify({ systemTwo: { use: "fake" }, plugins: { local: { from: "openai", config: { baseUrl: "http://localhost:1/v1", model: "a" } } } }))
  const script = `import { Context, Effect } from "effect"; import { Config } from "./src/base/config"; import { systemTwoServices } from "./src/loop/systems"
    Effect.runPromise(Effect.gen(function* () { const config = yield* Config; const { services, describe } = yield* systemTwoServices({ ...config, systemTwo: { ...config.systemTwo, use: "local:org/b:latest" } }); return [Context.get(services, Config).systemTwo.use, describe.long].join(" | ") }).pipe(Effect.scoped, Effect.provide(Config.layer))).then(console.log)`

  expect(runScript(dir, script)).toBe("local:org/b:latest | local (org/b:latest at http://localhost:1/v1)")
})

// /model inside a running session (System Two already provided): the turns get the new plugin's System Two, not the
// start-up one again (layers built in the same process share a memo map), and its Config; an unknown name changes nothing.
test("modelCommand: the next turns run with the new System Two and a Config naming it; a name that can't be made changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-plugins-"))
  writeFileSync(join(dir, "config.json"), JSON.stringify({ systemTwo: { use: "fake" }, plugins: { openai: { config: { baseUrl: "http://localhost:1/v1", model: "m" } } } }))
  const script = `import { Context, Effect } from "effect"; import { Config } from "./src/base/config"; import { modelCommand } from "./src/answer"; import { SystemTwoLayers } from "./src/loop/systems"; import { SystemTwo } from "./src/system-two/systemtwo"; import { newConversation } from "./src/loop/turnkit"
    const session = { dir: ${JSON.stringify(dir)}, id: "s", record: () => Effect.void }
    Effect.runPromise(Effect.gen(function* () {
      const services = yield* Effect.context()
      const c = newConversation(); c.backend = "fake"
      const bad = yield* modelCommand(session, c, "bogus", services)
      const good = yield* modelCommand(session, c, "openai", services)
      return [bad.services === services, c.backend, Context.get(good.services, SystemTwo) !== Context.get(services, SystemTwo), Context.get(good.services, Config).systemTwo.use].join(" | ")
    }).pipe(Effect.provide(SystemTwoLayers), Effect.provide(Config.layer))).then(console.log)`

  expect(runScript(dir, script)).toBe("true | openai | true | openai")
})

// Each /model's System Two lives in its own scope: the next switch closes it, so a replaced backend's resources go.
test("modelCommand: a switch closes the scope of the System Two it replaces; a failed one leaves it open", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-plugins-"))
  writeFileSync(join(dir, "config.json"), JSON.stringify({ systemTwo: { use: "fake" }, plugins: { openai: { config: { baseUrl: "http://localhost:1/v1", model: "m" } } } }))
  const script = `import { Effect } from "effect"; import { Config } from "./src/base/config"; import { modelCommand, modelScope } from "./src/answer"; import { SystemTwoLayers } from "./src/loop/systems"; import { newConversation } from "./src/loop/turnkit"
    const session = { dir: ${JSON.stringify(dir)}, id: "s", record: () => Effect.void }
    Effect.runPromise(Effect.gen(function* () {
      const c = newConversation(); c.backend = "fake"
      let services = yield* Effect.context()
      services = (yield* modelCommand(session, c, "openai", services)).services
      const first = modelScope()
      services = (yield* modelCommand(session, c, "fake", services)).services
      const second = modelScope()
      yield* modelCommand(session, c, "bogus", services)
      return [first.state._tag, second.state._tag, modelScope() === second].join(" | ")
    }).pipe(Effect.provide(SystemTwoLayers), Effect.provide(Config.layer))).then(console.log)`

  expect(runScript(dir, script)).toBe("Closed | Open | true")
})

// A conversation's agent: System One picks it for the first message (src/answer.ts, pickAgent); sure enough, the next
// turns run with the agent's config, System Two and instructions, and the session records it; not sure, or "root", as before.
test("pickAgent: System One's pick, if sure enough, becomes the conversation's agent; otherwise empty-vessel as itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-plugins-"))
  writeFileSync(join(dir, "config.json"), JSON.stringify({ systemTwo: { use: "fake" } }))
  mkdirSync(join(dir, "agents", "reviewer"), { recursive: true })
  writeFileSync(join(dir, "agents", "reviewer", "agent.md"), "---\ndescription: Reviews changes\nconfidence: 0.8\nsystemTwo: { reasoning: high }\nkernel: { tools: { files: read-only } }\n---\nReview, don't edit.")
  const run = (choice: string, confidence: number) => runScript(dir, `import { Context, Effect, Layer } from "effect"; import { Config } from "./src/base/config"; import { pickAgent } from "./src/answer"; import { SystemTwoLayers } from "./src/loop/systems"; import { SystemOne } from "./src/system-one/systemone"; import { newConversation } from "./src/loop/turnkit"
    const recorded = []
    const session = { dir: ${JSON.stringify(dir)}, id: "s", record: (role, text) => Effect.sync(() => recorded.push(role + " " + text)) }
    const one = Layer.succeed(SystemOne, { choose: (_s, options) => Effect.succeed({ choice: ${JSON.stringify(choice)}, confidence: ${confidence}, done: 0, tokens: { input: 0, output: 0 }, options }) })
    Effect.runPromise(Effect.gen(function* () {
      const services = yield* Effect.context()
      const c = newConversation(); c.backend = "fake" // as start-up leaves it
      const picked = yield* pickAgent(session, c, "review my last commit", services)
      const config = Context.get(picked.services, Config)
      return [picked.line ?? "-", c.agent ?? "-", c.instructions ?? "-", config.systemTwo.reasoning, config.kernel.tools.files, recorded.join(",") || "-"].join(" | ")
    }).pipe(Effect.provide(SystemTwoLayers), Effect.provide(one), Effect.provide(Config.layer))).then(console.log)`)

  expect(run("reviewer", 0.9)).toBe("working as reviewer (System One: 0.90) | reviewer | Review, don't edit. | high | read-only | agent reviewer")
  expect(run("reviewer", 0.6)).toBe("- | - | - | medium | read-write | -") // not sure enough for this agent (0.8)
  expect(run("root", 0.99)).toBe("- | - | - | medium | read-write | -")
})

// /agent before the first message, and a resumed session going on as its agent; System One picks only once.
test("agentCommand, resumeAgent and firstAgent: pick yourself before the first message, go on as before on resume, pick once", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-plugins-"))
  writeFileSync(join(dir, "config.json"), JSON.stringify({ systemTwo: { use: "fake" } }))
  mkdirSync(join(dir, "agents", "reviewer"), { recursive: true })
  writeFileSync(join(dir, "agents", "reviewer", "agent.md"), "---\ndescription: Reviews changes\nsystemTwo: { reasoning: high }\n---\nReview.")
  const out = runScript(dir, `import { Context, Effect, Layer } from "effect"; import { Config } from "./src/base/config"; import { agentCommand, firstAgent, resumeAgent } from "./src/answer"; import { SystemTwoLayers } from "./src/loop/systems"; import { SystemOne } from "./src/system-one/systemone"; import { newConversation } from "./src/loop/turnkit"
    let asked = 0
    const session = { dir: ${JSON.stringify(dir)}, id: "s", record: () => Effect.void }
    const one = Layer.succeed(SystemOne, { choose: () => Effect.sync(() => { asked++; return { choice: "reviewer", confidence: 0.95, done: 0, tokens: { input: 0, output: 0 } } }) })
    Effect.runPromise(Effect.gen(function* () {
      const services = yield* Effect.context()
      const lines = []
      const a = newConversation()
      lines.push((yield* agentCommand(session, a, "reviewer", services)).reply, (yield* agentCommand(session, a, "", services)).reply)
      a.history.push({ user: "hi", answer: "hello" })
      lines.push((yield* agentCommand(session, a, "root", services)).reply)

      const b = newConversation(); b.agent = "reviewer" // as loadConversation finds it
      const resumed = yield* resumeAgent(session, b, services)
      lines.push(resumed.line, b.instructions, Context.get(resumed.services, Config).systemTwo.reasoning)

      const c = newConversation(); c.agent = "root" // /agent root: System One doesn't pick
      yield* firstAgent(session, c, "review this", services)
      const d = newConversation(); d.history.push({ user: "x", answer: "y" }) // not the first message
      yield* firstAgent(session, d, "review this", services)
      const e = newConversation()
      yield* firstAgent(session, e, "/model codex", services) // a command, not a message
      lines.push("asked " + asked)
      const f = newConversation(); f.history.push({ user: "! ls", answer: "math.ts" }) // a shared command first: still the first message
      yield* firstAgent(session, f, "review this", services)
      lines.push("asked " + asked, f.agent)
      return lines.join(" | ")
    }).pipe(Effect.provide(SystemTwoLayers), Effect.provide(one), Effect.provide(Config.layer))).then(console.log)`)

  expect(out).toBe("working as reviewer (your pick) | agent: reviewer | this conversation works as reviewer; switching mid-conversation isn't built yet | working as reviewer (as before) | Review. | high | asked 0 | asked 1 | reviewer")
})

// An agent on another backend: the conversation's backend is the agent's (recorded), so /model and resume see it.
test("useAgent: an agent with its own backend makes that the conversation's backend, recorded", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-plugins-"))
  writeFileSync(join(dir, "config.json"), JSON.stringify({ systemTwo: { use: "fake" }, plugins: { local: { from: "openai", config: { baseUrl: "http://localhost:1/v1", model: "a" } } } }))
  mkdirSync(join(dir, "agents", "elsewhere"), { recursive: true })
  writeFileSync(join(dir, "agents", "elsewhere", "agent.md"), "---\ndescription: d\nsystemTwo: { use: \"local:b\" }\n---\nx")
  const out = runScript(dir, `import { Effect } from "effect"; import { Config } from "./src/base/config"; import { agentCommand, modelCommand } from "./src/answer"; import { SystemTwoLayers } from "./src/loop/systems"; import { newConversation } from "./src/loop/turnkit"
    const recorded = []
    const session = { dir: ${JSON.stringify(dir)}, id: "s", record: (role, text) => Effect.sync(() => recorded.push(role + " " + text)) }
    Effect.runPromise(Effect.gen(function* () {
      const c = newConversation(); c.backend = "fake"
      const used = yield* agentCommand(session, c, "elsewhere", yield* Effect.context())
      return [c.backend, recorded.join(","), (yield* modelCommand(session, c, "", used.services)).reply].join(" | ")
    }).pipe(Effect.provide(SystemTwoLayers), Effect.provide(Config.layer))).then(console.log)`)

  expect(out).toBe("local:b | systemTwo local:b,agent elsewhere | system two: local:b")
})
