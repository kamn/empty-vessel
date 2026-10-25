import { existsSync } from "node:fs"
import { Console, Effect, Redacted, Schema } from "effect"
import { Config, ConfigSchema, decodeConfig, readConfigObject, writeConfigFile } from "./base/config"
import { pluginSettings, type Provides } from "./plugins/plugin"
import { allPlugins, copies, PLUGINS } from "./plugins/index"
import { SETUP_FILE } from "./setup"
import { hidden, type ModelIo } from "./model"

// empty-vessel config: read and change config.json by dotted path, like `hermes config`. Secrets (what a plugin's
// settings mark Redacted, and keys named like one) show as <redacted> everywhere but `get --reveal`. A change is
// checked as a session would load it (the schema, which plugin each use names, the plugins in use's settings) and
// refused, the file unchanged, when it would break what loaded before.

export type ConfigIo = ModelIo

const REDACTED = "<redacted>"
const SECRET_NAME = /(api[-_]?key|token|secret|password|authorization)$/i
const object = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v)

// "a.b.c" as its parts; a part that's empty or would reach Object's prototype isn't a key.
const keyOf = (key: string) => {
  const parts = key.split(".")
  return parts.every((p) => p && !["__proto__", "constructor", "prototype"].includes(p)) ? parts : undefined
}

// A plugin's settings by its section's name: a bundled plugin's, or (plugins.<name>.from) the copied one's.
const settingsOf = (name: string, sections: Record<string, any>) =>
  PLUGINS.find((p) => p.name === name)?.settings ?? copies(sections).flatMap((c) => ("plugin" in c && c.plugin?.name === name ? [c.plugin.settings] : []))[0]

// One of a plugin's settings decoded alone: what it is (Redacted: a secret), or why the value can't be it.
const decodeSetting = (plugin: string, key: string, value: unknown, sections: Record<string, any>) => {
  const field = settingsOf(plugin, sections)?.fields[key]
  if (!field) return undefined
  const got = Schema.decodeUnknownResult(Schema.Struct({ [key]: field }) as unknown as Schema.Codec<Record<string, unknown>>)({ [key]: value })
  return got._tag === "Success" ? { value: got.success[key] } : { error: `plugins.${plugin}.config.${key}: ${got.failure.message.replace(/\s*\n\s*/g, " ")}` }
}

// The config with every secret replaced by <redacted>.
const redact = (config: Record<string, any>) => {
  const sections: Record<string, any> = object(config.plugins) ? config.plugins : {}
  const walk = (value: unknown, path: ReadonlyArray<string>): unknown => {
    if (Array.isArray(value)) return value.map((v, i) => walk(v, [...path, String(i)]))
    if (!object(value)) return value
    return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      const at = [...path, k]
      const marked = at.length === 4 && at[0] === "plugins" && at[2] === "config" && Redacted.isRedacted(decodeSetting(at[1]!, k, v, sections)?.value)
      return [k, marked || (SECRET_NAME.test(k) && v !== undefined && v !== null) ? REDACTED : walk(v, at)]
    }))
  }
  return walk(config, []) as Record<string, any>
}

// Whether this version knows the setting at this path: the config's schema, then plugins.<name>.config.<key> by that
// plugin's settings. An outside plugin's (plugins.<name>.path) can't be known without loading it, so any is taken.
const known = (parts: ReadonlyArray<string>, sections: Record<string, any>) => {
  let node: any = Schema.toJsonSchemaDocument(ConfigSchema).schema

  for (const [i, part] of parts.entries()) {
    if (i === 3 && parts[0] === "plugins" && parts[2] === "config") {
      const settings = settingsOf(parts[1]!, sections)
      if (!settings) return sections[parts[1]!]?.path !== undefined
      node = Schema.toJsonSchemaDocument(settings).schema
    }

    node = node?.properties?.[part] ?? (typeof node?.additionalProperties === "object" ? node.additionalProperties : undefined)
    if (!node) return false
  }

  return true
}

// What's wrong with a config as a session would load it: the schema, the plugin each use names, and the settings of
// the plugins in use (as doctor checks them). Empty: nothing.
const problems = (raw: Record<string, any>, file: string) =>
  Effect.gen(function* () {
    const decoded = yield* Effect.result(decodeConfig(structuredClone(raw), file))
    if (decoded._tag === "Failure") return [decoded.failure.message.replace(/\s*\n\s*/g, " ")]
    const config = decoded.success
    const { plugins, outside } = yield* allPlugins.pipe(Effect.provideService(Config, config))
    const uses: ReadonlyArray<readonly [keyof Provides, string]> = [
      ["systemOne", config.systemOne.use], ["systemTwo", config.systemTwo.use], ["store", config.store.use], ["memory", config.memory.use],
      ...(config.channel.use === "terminal" ? [] : [["channel", config.channel.use] as const]), ...config.actionGuard.use.map((u) => ["actionGuard", u] as const),
    ]
    const found: Array<string> = []

    for (const [kind, use] of uses) {
      const name = kind === "actionGuard" ? use : use.split(":")[0]!
      const failed = outside.find((o) => o.name === name && o.error)?.error
      if (failed) found.push(`${kind}.use is "${use}", a plugin that didn't load: ${failed}`)
      else if (!plugins.some((p) => p.name === name && p.provides[kind])) found.push(`${kind}.use is "${use}", but no plugin provides a ${kind} by that name (there are: ${plugins.filter((p) => p.provides[kind]).map((p) => p.name).join(", ")})`)
    }

    for (const plugin of plugins.filter((p) => p.settings && uses.some(([kind, use]) => (kind === "actionGuard" ? use : use.split(":")[0]) === p.name))) {
      const got = yield* Effect.result(pluginSettings(plugin.name, plugin.settings as never).pipe(Effect.provideService(Config, config)))
      if (got._tag === "Failure") found.push(got.failure.message.replace(/\s*\n\s*/g, " "))
    }

    return found
  })

// The file as a JSON object; undefined (said) when it isn't one.
const read = (file: string, io: ConfigIo) =>
  Effect.gen(function* () {
    const raw = readConfigObject(file)
    if (!raw) yield* io.say(`✗ ${file} isn't a JSON object empty-vessel can read. Fix it (empty-vessel config edit) or move it aside.`)
    return raw
  })

// What's at a path, if anything.
const at = (config: unknown, parts: ReadonlyArray<string>) =>
  parts.reduce<{ value: unknown } | undefined>((got, p) => (got && typeof got.value === "object" && got.value !== null && Object.hasOwn(got.value, p) ? { value: (got.value as any)[p] } : undefined), { value: config })

const shown = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2))

// empty-vessel config show: the file, secrets redacted.
export const configShow = (file: string, io: ConfigIo) =>
  Effect.gen(function* () {
    const raw = yield* read(file, io)
    if (!raw) return false
    yield* io.say(JSON.stringify(redact(raw), null, 2))
    return true
  })

// empty-vessel config get <key> [--reveal]: one value (a secret redacted unless revealed). False: there's none.
export const configGet = (file: string, key: string, reveal: boolean, io: ConfigIo) =>
  Effect.gen(function* () {
    const raw = yield* read(file, io)
    const parts = keyOf(key)
    if (!raw) return false
    const got = parts && at(reveal ? raw : redact(raw), parts)
    if (!got) yield* io.say(`✗ ${key} isn't set in ${file}`)
    else yield* io.say(shown(got.value))
    return got !== undefined
  })

// empty-vessel config set <key> [value] [--force]: the value (JSON when it parses, else the text; asked without echo
// when not given) at that path, the objects on the way made. False: refused, the file unchanged.
export const configSet = (file: string, key: string, given: string | undefined, force: boolean, io: ConfigIo) =>
  Effect.gen(function* () {
    const raw = yield* read(file, io)
    const parts = keyOf(key)
    if (!raw) return false
    if (!parts) return yield* io.say(`✗ "${key}" isn't a dotted key (e.g. systemTwo.use)`).pipe(Effect.as(false))

    const text = given ?? io.secret(`  ${key} (not shown as you type):`)
    if (!text) return yield* io.say("Nothing changed.").pipe(Effect.as(false))
    const value: unknown = (() => { try { return JSON.parse(text) } catch { return text } })()

    // The new config: a copy, each object on the way made (or refused when something else is in the way).
    const next = structuredClone(raw)
    let parent: Record<string, any> = next

    for (const [i, part] of parts.slice(0, -1).entries()) {
      if (parent[part] === undefined) parent[part] = {}
      if (!object(parent[part])) return yield* io.say(`✗ ${parts.slice(0, i + 1).join(".")} is ${JSON.stringify(parent[part])}, not an object: can't set ${key} inside it`).pipe(Effect.as(false))
      parent = parent[part]
    }

    parent[parts.at(-1)!] = value

    // Refused: a plugin setting this value can't be, or anything a session would now fail to load that it didn't.
    const sections: Record<string, any> = object(next.plugins) ? next.plugins : {}
    const single = parts.length === 4 && parts[0] === "plugins" && parts[2] === "config" ? decodeSetting(parts[1]!, parts[3]!, value, sections) : undefined
    const before = new Set(yield* problems(raw, file))
    const wrong = [...(single?.error ? [single.error] : []), ...(yield* problems(next, file)).filter((p) => !before.has(p))]

    if (wrong.length) {
      yield* io.say(`✗ ${key} not set, the file unchanged:${wrong.map((w) => `\n  ${w}`).join("")}`)
      return false
    }

    writeConfigFile(file, next)
    yield* io.say(known(parts, sections) || force ? `Set ${key} in ${file}.` : `Set ${key} in ${file}: saved, but ${key} isn't a setting this version knows (a typo? --force hides this).`)
    return true
  })

// empty-vessel config unset <key>: removed, if it was there.
export const configUnset = (file: string, key: string, io: ConfigIo) =>
  Effect.gen(function* () {
    const raw = yield* read(file, io)
    const parts = keyOf(key)
    if (!raw) return false
    const parent = parts && at(raw, parts.slice(0, -1))?.value
    if (!parts || !object(parent) || !Object.hasOwn(parent, parts.at(-1)!)) return yield* io.say(`${key} isn't set: nothing changed.`).pipe(Effect.as(true))

    delete parent[parts.at(-1)!]
    writeConfigFile(file, raw)
    yield* io.say(`Removed ${key} from ${file}.`)
    return true
  })

// empty-vessel config check: what a session would fail on. False: something.
export const configCheck = (file: string, io: ConfigIo) =>
  Effect.gen(function* () {
    const raw = yield* read(file, io)
    if (!raw) return false
    const wrong = yield* problems(raw, file)
    yield* io.say(wrong.length ? wrong.map((w) => `✗ ${w}`).join("\n") : `✓ ${file}: no problems`)
    return wrong.length === 0
  })

// empty-vessel config edit: the file in $VISUAL / $EDITOR (vi), made first if missing (private), then checked.
export const configEdit = (file: string, io: ConfigIo, open: (file: string) => void) =>
  Effect.gen(function* () {
    if (!existsSync(file)) writeConfigFile(file, {})
    open(file)
    return yield* configCheck(file, io)
  })

const editor = (file: string) => {
  Bun.spawnSync(["sh", "-c", `${process.env.VISUAL || process.env.EDITOR || "vi"} "$1"`, "sh", file], { stdio: ["inherit", "inherit", "inherit"] })
}
const io: ConfigIo = { ask: (question) => prompt(question), secret: hidden, say: (line) => Console.log(line) }
const exit = (ok: Effect.Effect<boolean>) => ok.pipe(Effect.tap((good) => Effect.sync(() => { if (!good) process.exitCode = 1 })))

export const showConfigHere = exit(configShow(SETUP_FILE, io))
export const getConfigHere = (key: string, reveal: boolean) => exit(configGet(SETUP_FILE, key, reveal, io))
export const setConfigHere = (key: string, value: string | undefined, force: boolean) => exit(configSet(SETUP_FILE, key, value, force, io))
export const unsetConfigHere = (key: string) => exit(configUnset(SETUP_FILE, key, io))
export const configPathHere = Console.log(SETUP_FILE)
export const editConfigHere = exit(configEdit(SETUP_FILE, io, editor))
export const checkConfigHere = exit(configCheck(SETUP_FILE, io))
