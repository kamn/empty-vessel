import { Console, Effect } from "effect"
import { movedIntoPlugins, readConfigObject, writeConfigFile } from "./base/config"
import { codexModels, copies, DEFAULT_BASE_URL, listModels, PLUGINS, SETUPS } from "./plugins/index"
import { SETUP_FILE, type SetupIo } from "./setup"

// empty-vessel model: which System Two (and its model) the config chooses, like `hermes model`. Pick one of the
// providers there are, then its model (the server's list for an OpenAI-compatible one, Codex's cached list, or typed);
// or add an OpenAI-compatible endpoint as a copy of the openai plugin (plugins.<name> = { from: "openai", config }).

// How it talks to you: setup's question and line, plus a question whose answer isn't shown (the key). What it reaches:
// the servers (fetch) and the models Codex last saw. Passed in, so a test can answer.
export type ModelIo = SetupIo & { readonly secret: (question: string) => string | null }
export type ModelDeps = { readonly fetch: typeof fetch; readonly codexModels: () => ReadonlyArray<string> }

type Provider = { readonly name: string; readonly title: string; readonly openai: boolean; readonly model?: string }
type Endpoint = { readonly baseUrl: string; readonly apiKey: string; readonly models: ReadonlyArray<string> }

const CLAUDE_MODELS = ["opus", "sonnet", "haiku"] // Claude Code's names for its current models
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const yes = (answer: string | null) => /^y(es)?$/i.test((answer ?? "").trim())
const webAddress = (url: string) => URL.canParse(url) && /^https?:$/.test(new URL(url).protocol)

// "name:model" (systemTwo.use can say which model for this use) as its two halves.
const split = (use: string) => [use.split(":")[0]!, use.split(":").slice(1).join(":") || undefined] as const

// The System Twos to choose from: the bundled ones setup knows, and every copy of openai the config has.
const providers = (config: Record<string, any>): ReadonlyArray<Provider> => {
  const sections: Record<string, any> = config.plugins ?? {}
  const theirs = copies(sections).flatMap((c) => ("plugin" in c && c.plugin?.setup ? [c.plugin.setup] : []))
  return [...SETUPS, ...theirs].filter((s) => s.kind === "systemTwo").map((s) => ({
    name: s.name, title: s.title, openai: s.name === "openai" || sections[s.name]?.from === "openai", model: sections[s.name]?.config?.model,
  }))
}

// The config as it is, in today's shape; undefined (said) when it isn't one empty-vessel can rewrite.
const read = (file: string, io: SetupIo) =>
  Effect.gen(function* () {
    const raw = readConfigObject(file)
    if (!raw) yield* io.say(`${file} isn't a JSON object empty-vessel can read, so nothing changed. Fix it (or move it aside) and try again.`)
    return raw && movedIntoPlugins(raw)
  })

// System Two becomes `use` (when given), with these settings merged into plugin `name`'s section.
const save = (file: string, config: Record<string, any>, use: string | undefined, name: string, section: Record<string, any>) => {
  const was = config.plugins?.[name] ?? {}
  writeConfigFile(file, {
    ...config,
    ...(use ? { systemTwo: { ...config.systemTwo, use } } : {}),
    plugins: { ...config.plugins, [name]: { ...was, ...section, config: { ...was.config, ...section.config } } },
  })
}

// A model from a list (by number or name) or typed; Enter keeps the current one (or none).
const pickModel = (io: SetupIo, models: ReadonlyArray<string>, current?: string) =>
  Effect.gen(function* () {
    if (models.length) yield* io.say(models.map((m, i) => `    ${i + 1}. ${m}${m === current ? " (current)" : ""}`).join("\n"))
    const answer = (io.ask(`  Model${models.length ? ", a number or a name" : " (its name)"}${current ? ` (Enter keeps ${current})` : ""}:`) ?? "").trim()
    return models[Number(answer) - 1] ?? (answer || current)
  })

// An OpenAI-compatible server's address and key, tried once (does it list its models?). One that doesn't can still
// be kept, its model typed; undefined: nothing to keep.
const askEndpoint = (io: ModelIo, deps: ModelDeps) =>
  Effect.gen(function* () {
    const baseUrl = (io.ask("  API address, up to /v1 (e.g. https://openrouter.ai/api/v1, http://localhost:11434/v1):") ?? "").trim().replace(/\/$/, "")
    if (!webAddress(baseUrl)) {
      yield* io.say(`  ✗ ${baseUrl ? `"${baseUrl}" isn't an http(s) address` : "no address given"}`)
      return undefined
    }

    const apiKey = (io.secret("  API key (not shown as you type; Enter for none, e.g. a local server):") ?? "").trim()
    const listed = yield* listModels(baseUrl, apiKey, deps.fetch)

    if ("error" in listed) {
      yield* io.say(`  ✗ ${listed.error}`)
      if (!yes(io.ask("  Keep it anyway, typing the model's name yourself? (y/N):"))) return undefined
    } else yield* io.say(`  ✓ it lists ${listed.models.length} model${listed.models.length === 1 ? "" : "s"}`)

    return { baseUrl, apiKey, models: "models" in listed ? listed.models : [] } satisfies Endpoint
  })

// "Add an OpenAI-compatible endpoint": a name of its own, the server, its model; saved as a copy of openai, and System
// Two if you say so.
const addEndpoint = (file: string, config: Record<string, any>, io: ModelIo, deps: ModelDeps) =>
  Effect.gen(function* () {
    let name = ""

    while (true) {
      name = (io.ask("  A name for it (letters, digits and _, e.g. openrouter or ollama; Enter to stop):") ?? "").trim()
      if (!name) return yield* io.say("Nothing changed.")
      const why = !NAME.test(name) ? `"${name}" can't be a name: letters, digits and _, not starting with a digit`
        : PLUGINS.some((p) => p.name === name) ? `${name} is a bundled plugin's name: choose another`
        : config.plugins?.[name] ? `plugins.${name} is already there: choose another (or pick it from the list)`
        : undefined
      if (!why) break
      yield* io.say(`  ✗ ${why}`)
    }

    const endpoint = yield* askEndpoint(io, deps)
    if (!endpoint) return yield* io.say("Nothing changed.")
    const model = yield* pickModel(io, endpoint.models)
    if (!model) return yield* io.say("✗ an OpenAI-compatible API needs a model: nothing changed.")

    const now = !/^n(o)?$/i.test((io.ask(`  Make ${name} System Two now? (Y/n):`) ?? "").trim())
    save(file, config, now ? name : undefined, name, { from: "openai", config: { baseUrl: endpoint.baseUrl, model, ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}) } })
    yield* io.say(`Added ${name} (${model} at ${endpoint.baseUrl})${now ? ", now System Two" : `; choose it with: empty-vessel model use ${name}`}. Saved in ${file}.`)
  })

// The interactive picker.
export const runModel = (file: string, io: ModelIo, deps: ModelDeps) =>
  Effect.gen(function* () {
    const config = yield* read(file, io)
    if (!config) return
    const list = providers(config)
    const [used, usedModel] = split(config.systemTwo?.use ?? "fake")

    yield* io.say(["System Two: which provider?", ...list.map((p, i) => `  ${i + 1}. ${p.name}: ${p.title}${p.model ? ` · ${p.model}` : ""}${p.name === used ? " (in use)" : ""}`),
      `  ${list.length + 1}. Add an OpenAI-compatible endpoint`, ...(list.some((p) => p.name === used) ? [] : [`  (in use now: ${used})`])].join("\n"))
    const answer = (io.ask("  Number (Enter leaves it as it is):") ?? "").trim()
    if (Number(answer) === list.length + 1) return yield* addEndpoint(file, config, io, deps)
    const provider = list[Number(answer) - 1] ?? list.find((p) => p.name === answer)
    if (!provider) return yield* io.say(answer ? `✗ ${answer} isn't one of them: nothing changed.` : "Nothing changed.")

    // Its models: an OpenAI-compatible one's server is asked (an openai section with no address or key yet is asked
    // for them first); Codex's are the ones it last saw; Claude Code's are its names.
    const current = (provider.name === used ? usedModel : undefined) ?? provider.model
    const section: Record<string, any> = config.plugins?.[provider.name]?.config ?? {}
    let settings: Record<string, unknown> = {}
    let models: ReadonlyArray<string> = provider.name === "codex" ? deps.codexModels() : provider.name === "claude" ? CLAUDE_MODELS : []

    if (provider.openai && section.baseUrl === undefined && section.apiKey === undefined) {
      const endpoint = yield* askEndpoint(io, deps)
      if (!endpoint) return yield* io.say("Nothing changed.")
      settings = { baseUrl: endpoint.baseUrl, ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}) }
      models = endpoint.models
    } else if (provider.openai) {
      const listed = yield* listModels(String(section.baseUrl ?? DEFAULT_BASE_URL), section.apiKey, deps.fetch)
      if ("error" in listed) yield* io.say(`  ✗ ${listed.error}; type the model's name`)
      models = "models" in listed ? listed.models : []
    }

    const model = yield* pickModel(io, models, current)
    if (!model && provider.openai) return yield* io.say("✗ an OpenAI-compatible API needs a model: nothing changed.")

    save(file, config, provider.name, provider.name, { config: { ...settings, ...(model ? { model } : {}) } })
    yield* io.say(`System Two: ${provider.name}${model ? ` (${model})` : ""}. Saved in ${file}.`)
  })

// empty-vessel model list: the providers, the one in use marked (*), each one's model; nothing is asked or fetched.
export const modelList = (file: string, io: SetupIo) =>
  Effect.gen(function* () {
    const config = yield* read(file, io)
    if (!config) return
    const [used, usedModel] = split(config.systemTwo?.use ?? "fake")
    const list = providers(config)

    for (const p of list) yield* io.say(`${p.name === used ? "*" : " "} ${p.name.padEnd(12)} ${((p.name === used ? usedModel : undefined) ?? p.model ?? "(its default)").padEnd(24)} ${p.title}`)
    if (!list.some((p) => p.name === used)) yield* io.say(`(in use now: ${used})`)
  })

// empty-vessel model use <name[:model]>: System Two becomes that provider (and its model, when given). False: refused.
export const modelUse = (file: string, target: string, io: SetupIo) =>
  Effect.gen(function* () {
    const config = yield* read(file, io)
    if (!config) return false
    const [name, model] = split(target)
    const list = providers(config)
    const provider = list.find((p) => p.name === name)

    if (!provider) {
      yield* io.say(`✗ no System Two named ${name} (there are: ${list.map((p) => p.name).join(", ")}). Add an OpenAI-compatible one with: empty-vessel model`)
      return false
    }

    if (provider.openai && !model && !provider.model) {
      yield* io.say(`✗ ${name} has no model yet: empty-vessel model use ${name}:<model>`)
      return false
    }

    save(file, config, name, name, model ? { config: { model } } : {})
    yield* io.say(`System Two: ${name}${model ?? provider.model ? ` (${model ?? provider.model})` : ""}. Saved in ${file}.`)
    return true
  })

// At the terminal: questions by prompt(), the key's with echo off (stty), lines printed.
const hidden = (question: string) => {
  if (!process.stdin.isTTY) return prompt(question)
  Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" })
  try { return prompt(question) } finally { Bun.spawnSync(["stty", "echo"], { stdin: "inherit" }); process.stdout.write("\n") }
}
const io: ModelIo = { ask: (question) => prompt(question), secret: hidden, say: (line) => Console.log(line) }
const deps: ModelDeps = { fetch, codexModels }

export const model = runModel(SETUP_FILE, io, deps)
export const listModelsHere = modelList(SETUP_FILE, io)
export const useModelHere = (target: string) => modelUse(SETUP_FILE, target, io).pipe(Effect.tap((ok) => Effect.sync(() => { if (!ok) process.exitCode = 1 })))
