import { Effect, Layer } from "effect"
import { Config, ConfigError } from "../base/config"
import type { Plugin, Provides } from "./plugin"
import { memoryOnStore } from "../base/memory"
import type { PluginSetup } from "../base/plugin-setup"
import { diskStore } from "../base/store"
import { FakeSystemOne } from "../system-one/systemone"
import { FakeAsk } from "../system-two/ask"
import { FakeFill } from "../system-two/fill"
import { FakeSystemTwo } from "../system-two/systemtwo"
import { claude } from "./claude"
import { codex } from "./codex"
import { jev, jevMock } from "./jev"
import { openai, openaiAs } from "./openai"
import { telegram } from "./telegram"
import { loadOutside } from "./outside"

// The plugins bundled with empty-vessel, and which of them the config picks. The only file that
// knows the list: the core uses the contracts (src/base/plugin.ts and the services it names), a plugin never imports
// another. Plugins from outside (plugins.<name>.path) join them the first time a kind is chosen (src/plugins/outside.ts).

// The core's fakes, as a plugin: fixed rules, no model.
const fake: Plugin = {
  name: "fake",
  provides: {
    systemOne: Effect.succeed(FakeSystemOne),
    systemTwo: Effect.succeed({ systemTwo: FakeSystemTwo, fill: FakeFill, ask: FakeAsk, describe: { long: "fake", short: "fake" } }),
  },
}

// The core's own store and memory: ~/.empty-vessel, and notes kept in the store (for the project empty-vessel was started in).
const disk: Plugin = { name: "disk", provides: { store: Effect.succeed(diskStore()) } }
const notes: Plugin = { name: "notes", provides: { memory: Effect.gen(function* () {
  const { memory } = yield* Config
  return memoryOnStore(process.cwd(), { project: memory.projectChars, agent: memory.agentChars })
}) } }

export const PLUGINS: ReadonlyArray<Plugin> = [fake, disk, notes, jev, jevMock, codex, claude, openai, telegram]

// What each plugin needs before it can be used, for `empty-vessel setup`, in the order offered.
export const SETUPS: ReadonlyArray<PluginSetup> = PLUGINS.flatMap((p) => (p.setup ? [p.setup] : []))

// The settings each plugin declares, by name (for doctor).
export const SETTINGS = Object.fromEntries(PLUGINS.flatMap((p) => (p.settings ? [[p.name, p.settings]] : [])))

// The outside plugins a config's plugin sections name, loaded once per process (for each set of sections).
const loaded = new Map<string, Effect.Success<ReturnType<typeof loadOutside>>>()
export const outsideIn = (sections: Readonly<Record<string, { readonly path?: string; readonly enabled?: boolean }>>) =>
  Effect.gen(function* () {
    const key = JSON.stringify(sections)
    if (!loaded.has(key)) loaded.set(key, yield* loadOutside(sections, PLUGINS.map((p) => p.name)))
    return loaded.get(key)!
  })
const outside = Effect.gen(function* () { return yield* outsideIn((yield* Config).plugins) })

// The bundled plugins a config section can copy (plugins.<name>.from), each copy reading its settings from that section.
const COPYABLE: Readonly<Record<string, (name: string) => Plugin>> = { openai: openaiAs }
export const copies = (sections: Readonly<Record<string, { readonly from?: string; readonly enabled?: boolean }>>) =>
  Object.entries(sections).filter(([, s]) => s.from && s.enabled !== false).map(([name, s]) =>
    PLUGINS.some((p) => p.name === name) ? { name, error: `${name} is a bundled plugin's name` }
    : COPYABLE[s.from!] ? { name, plugin: COPYABLE[s.from!]!(name) }
    : { name, error: `from is "${s.from}", but only ${Object.keys(COPYABLE).join(", ")} can be copied` })

// Every plugin the config can choose: the bundled ones, their copies, and the outside ones that loaded (with why the
// others didn't).
export const allPlugins = Effect.gen(function* () {
  const others = [...(yield* outside), ...copies((yield* Config).plugins)]
  return {
    plugins: [...PLUGINS, ...others.flatMap((o) => ("plugin" in o && o.plugin ? [o.plugin] : []))],
    outside: others.map((o) => ({ name: o.name, ...("error" in o ? { error: o.error } : {}) })),
  }
})

// What the config chose for a kind (<kind>.use): made by the plugin of that name that provides it, bundled or outside.
// "plugin:model" (claude:opus, openrouter:org/some-model) is that plugin with its model setting replaced, for this use.
const chosen = <K extends keyof Provides>(kind: K) =>
  Effect.gen(function* () {
    const config = yield* Config
    const use = config[kind].use
    const [name, model] = [use.split(":")[0]!, use.split(":").slice(1).join(":")]
    const { plugins: all, outside: others } = yield* allPlugins
    const plugin = all.find((p) => p.name === name && p.provides[kind])
    const failed = others.find((o) => o.name === name && o.error)
    if (failed?.error) return yield* new ConfigError({ message: `${kind}.use is "${use}", a plugin that didn't load: ${failed.error}` })
    if (!plugin) {
      const offered = all.filter((p) => p.provides[kind]).map((p) => p.name).join(", ")
      return yield* new ConfigError({ message: `${kind}.use is "${use}", but no plugin provides a ${kind} by that name (there are: ${offered})` })
    }

    const section = config.plugins[name] ?? {}
    const plugins = model ? { ...config.plugins, [name]: { ...section, config: { ...(section.config as object), model } } } : config.plugins
    const made = plugin.provides[kind]! as Effect.Effect<Effect.Success<NonNullable<Provides[K]>>, ConfigError, Config>
    return yield* made.pipe(Effect.provideService(Config, { ...config, plugins }))
  })

// Only nonterminal routing builds this layer; terminal is the entry point's built-in sentinel.
export const ChannelFromConfig = Layer.unwrap(chosen("channel"))

export const SystemOneFromConfig = Layer.unwrap(chosen("systemOne"))
export const SystemTwoFromConfig = Layer.unwrap(chosen("systemTwo").pipe(Effect.map((p) => p.systemTwo)))
// The Fill (a small model filling in tool arguments) that goes with it.
export const FillFromConfig = Layer.unwrap(chosen("systemTwo").pipe(Effect.map((p) => p.fill)))
// Ask (one structured question to the main model: the reviewer, adoption), so empty-vessel's looks back at a turn use the
// backend you chose.
export const AskFromConfig = Layer.unwrap(chosen("systemTwo").pipe(Effect.map((p) => p.ask)))
// The store, and the memory kept in it: together, since the memory needs the store.
export const StoreAndMemoryFromConfig = Layer.unwrap(chosen("memory")).pipe(Layer.provideMerge(Layer.unwrap(chosen("store"))))
// System Two in words, for the start of a session: long and short.
export const describeSystemTwo = chosen("systemTwo").pipe(Effect.map((p) => p.describe))
