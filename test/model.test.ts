import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { modelList, modelUse, runModel } from "../src/model"

// A server that lists two models for the right key, refuses any other (and records what it was asked).
const server = (calls: Array<{ url: string; auth?: string }> = []) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization
    calls.push({ url: String(input), auth })
    return auth === "Bearer sk-good"
      ? Response.json({ data: [{ id: "org/zeta" }, { id: "org/alpha" }] })
      : new Response("no", { status: 401 })
  }) as unknown as typeof fetch

// `empty-vessel model` with scripted answers (ask, then the hidden one); the config written and everything said.
const pick = async (answers: ReadonlyArray<string>, options: { before?: object; secrets?: ReadonlyArray<string>; fetch?: typeof fetch } = {}) => {
  const file = join(mkdtempSync(join(tmpdir(), "empty-vessel-model-")), "config.json")
  if (options.before) writeFileSync(file, JSON.stringify(options.before))
  const said: Array<string> = [], queue = [...answers], secrets = [...(options.secrets ?? [])]
  const io = { ask: () => queue.shift() ?? "", secret: () => secrets.shift() ?? "", say: (l: string) => Effect.sync(() => { said.push(l) }) }
  await Effect.runPromise(runModel(file, io, { fetch: options.fetch ?? server(), codexModels: () => ["gpt-a", "gpt-b"] }))
  const written = (() => { try { return readFileSync(file, "utf8") } catch { return undefined } })()
  return { file, config: written && JSON.parse(written), written, said: said.join("\n") }
}

// The menu: codex, claude, openai, then the copies, then "Add an OpenAI-compatible endpoint".
const ADD = (copies = 0) => String(4 + copies)

test("adding an endpoint writes a copy of openai (key kept, never printed) and switches System Two to it", async () => {
  const calls: Array<{ url: string; auth?: string }> = []
  const { config, said, file } = await pick([ADD(), "openrouter", "https://openrouter.ai/api/v1/", "2", ""], { before: { theme: "teal", systemTwo: { use: "codex", reasoning: "high" } }, secrets: ["sk-good"], fetch: server(calls) })

  expect(config).toEqual({
    theme: "teal",
    systemTwo: { use: "openrouter", reasoning: "high" },
    plugins: { openrouter: { from: "openai", config: { baseUrl: "https://openrouter.ai/api/v1", model: "org/zeta", apiKey: "sk-good" } } },
  })
  expect(calls).toEqual([{ url: "https://openrouter.ai/api/v1/models", auth: "Bearer sk-good" }])
  expect(said).toContain("✓ it lists 2 models")
  expect(said).not.toContain("sk-good")
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test("an added endpoint can stay unused: System Two is left as it was", async () => {
  const { config } = await pick([ADD(), "local", "http://localhost:11434/v1", "1", "n"], { before: { systemTwo: { use: "codex" } }, secrets: ["sk-good"] })
  expect(config.systemTwo.use).toBe("codex")
  expect(config.plugins.local).toEqual({ from: "openai", config: { baseUrl: "http://localhost:11434/v1", model: "org/alpha", apiKey: "sk-good" } })
})

test("picking an existing copy switches to it, its models listed with its own address and key", async () => {
  const before = { systemTwo: { use: "codex" }, plugins: { openrouter: { from: "openai", config: { baseUrl: "https://openrouter.ai/api/v1", model: "org/alpha", apiKey: "sk-good" } } } }
  const { config, said } = await pick(["4", "2"], { before })

  expect(said).toContain("4. openrouter: openrouter, an OpenAI-compatible API · org/alpha")
  expect(said).toContain("5. Add an OpenAI-compatible endpoint")
  expect(config.systemTwo.use).toBe("openrouter")
  expect(config.plugins.openrouter.config).toEqual({ baseUrl: "https://openrouter.ai/api/v1", model: "org/zeta", apiKey: "sk-good" })
  expect(said).not.toContain("sk-good")
})

test("codex: its cached models offered, the pick saved as its model", async () => {
  const { config } = await pick(["1", "2"], { before: { systemTwo: { use: "openai" } } })
  expect(config).toEqual({ systemTwo: { use: "codex" }, plugins: { codex: { config: { model: "gpt-b" } } } })
})

test("a refused key is said plainly; declining to keep it changes nothing", async () => {
  const { said, written } = await pick([ADD(), "openrouter", "https://openrouter.ai/api/v1", "n"], { secrets: ["sk-wrong"] })
  expect(said).toContain("✗ https://openrouter.ai/api/v1/models refused the key (HTTP 401)")
  expect(said).toContain("Nothing changed.")
  expect(said).not.toContain("sk-wrong")
  expect(written).toBeUndefined()
})

test("an unreachable server can still be kept, its model typed", async () => {
  const down = (() => Promise.reject(new Error("connection refused"))) as unknown as typeof fetch
  const { config, said } = await pick([ADD(), "lab", "http://localhost:9/v1", "y", "my-model", ""], { fetch: down })
  expect(said).toContain("couldn't list http://localhost:9/v1/models: connection refused")
  expect(config.plugins.lab.config).toEqual({ baseUrl: "http://localhost:9/v1", model: "my-model" })
  expect(config.systemTwo.use).toBe("lab")
})

test("an address that isn't http(s) is refused before anything is fetched", async () => {
  const calls: Array<{ url: string }> = []
  const { said, written } = await pick([ADD(), "lab", "openrouter.ai"], { fetch: server(calls) })
  expect(said).toContain(`✗ "openrouter.ai" isn't an http(s) address`)
  expect(calls).toEqual([])
  expect(written).toBeUndefined()
})

test("a name that's a bundled plugin's (or not a name) is refused, and asked again", async () => {
  const { said, config } = await pick([ADD(), "codex", "9lives", "mine", "http://localhost:1234/v1", "1", ""], { secrets: ["sk-good"] })
  expect(said).toContain("✗ codex is a bundled plugin's name: choose another")
  expect(said).toContain(`✗ "9lives" can't be a name`)
  expect(Object.keys(config.plugins)).toEqual(["mine"])
})

test("a config that isn't a JSON object is left alone", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "empty-vessel-model-")), "config.json")
  writeFileSync(file, "{ broken")
  const said: Array<string> = []
  await Effect.runPromise(runModel(file, { ask: () => "1", secret: () => "", say: (l) => Effect.sync(() => { said.push(l) }) }, { fetch: server(), codexModels: () => [] }))
  expect(readFileSync(file, "utf8")).toBe("{ broken")
  expect(said.join("\n")).toContain("nothing changed")
})

test("model list marks the one in use; model use switches, refusing an unknown name", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "empty-vessel-model-")), "config.json")
  writeFileSync(file, JSON.stringify({ systemTwo: { use: "codex:gpt-x" }, plugins: { local: { from: "openai", config: { baseUrl: "http://localhost:1/v1", model: "m1", apiKey: "sk-secret" } } } }))
  const said: Array<string> = []
  const io = { ask: () => "", say: (l: string) => Effect.sync(() => { said.push(l) }) }

  await Effect.runPromise(modelList(file, io))
  expect(said.find((l) => l.slice(2).startsWith("codex "))).toMatch(/^\* codex\s+gpt-x/)
  expect(said.find((l) => l.slice(2).startsWith("local "))).toMatch(/^ {2}local\s+m1/)

  expect(await Effect.runPromise(modelUse(file, "nope", io))).toBe(false)
  expect(await Effect.runPromise(modelUse(file, "local:m2", io))).toBe(true)
  const config = JSON.parse(readFileSync(file, "utf8"))
  expect(config.systemTwo.use).toBe("local")
  expect(config.plugins.local.config).toEqual({ baseUrl: "http://localhost:1/v1", model: "m2", apiKey: "sk-secret" })
  expect(said.join("\n")).not.toContain("sk-secret")
})
