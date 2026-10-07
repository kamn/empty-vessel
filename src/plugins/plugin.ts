import { Data, Effect, type Layer, Schema } from "effect"
import type { Channel } from "../base/channel"
import type { Ask } from "../system-two/ask"
import type { Fill } from "../system-two/fill"
import type { SystemOne } from "../system-one/systemone"
import type { SystemTwo } from "../system-two/systemtwo"
import { Config, ConfigError } from "../base/config"
import type { Memory } from "../base/memory"
import type { PluginSetup } from "../base/plugin-setup"
import type { Settings } from "../base/setting"
import type { Store } from "../base/store"

// A plugin: a name the config can choose (systemOne.use, systemTwo.use, store.use, memory.use), its settings, what it
// needs before it can be used, and what it provides, by kind. Each is made when chosen, from the config.

// A plugin's own failure while starting (a login that expired): `what` says which, e.g. "codex login".
export class PluginError extends Data.TaggedError("PluginError")<{ what: string; message: string }> {}

// A System Two comes with its Fill and Ask (the same backend's), and says what it is for the start of a session.
export type SystemTwoParts = {
  readonly systemTwo: Layer.Layer<SystemTwo, PluginError>
  readonly fill: Layer.Layer<Fill>
  readonly ask: Layer.Layer<Ask>
  readonly describe: { readonly long: string; readonly short: string } // "codex (gpt-6-astra, medium reasoning)", "gpt-6-astra (medium)"
}

export type Provides = {
  readonly channel?: Effect.Effect<Layer.Layer<Channel, PluginError>, ConfigError, Config>
  readonly systemOne?: Effect.Effect<Layer.Layer<SystemOne>, ConfigError, Config>
  readonly systemTwo?: Effect.Effect<SystemTwoParts, ConfigError, Config>
  readonly store?: Effect.Effect<Layer.Layer<Store>, ConfigError, Config>
  readonly memory?: Effect.Effect<Layer.Layer<Memory, never, Store>, ConfigError, Config> // on top of the chosen store
}

export type Plugin = {
  readonly name: string
  readonly core?: string // which cores it works with, a semver range ("0.0.8", ">=0.0.5 <=0.0.9"): required of a plugin from outside (src/plugins/outside.ts)
  readonly settings?: Settings<any> // plugins.<name>.config (its config.ts): described({ … setting(…) }), each setting described
  readonly setup?: PluginSetup // for empty-vessel setup and doctor (its setup.ts)
  readonly provides: Provides
}

// A plugin's settings: its section of config.json (plugins.<name>.config), with the environment's values over it for
// one run (EMPTY_VESSEL_CODEX_MODEL for codex's model, EMPTY_VESSEL_JEV_API_KEY for jev's apiKey), then the defaults it declares.
// Checked strictly: a value of the wrong kind, or a setting it doesn't have (a typo), is an error naming the plugin,
// never a silent default. Where values come from is decided here, not by the plugin (later, e.g. a .env or a secrets
// folder: one more source merged in).
const envName = (plugin: string, key: string) => `EMPTY_VESSEL_${plugin}_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2")}`.toUpperCase()
export const pluginSettings = <S extends Schema.Struct<any>>(name: string, settings: S) =>
  Effect.gen(function* () {
    const { plugins } = yield* Config
    const section = (plugins[name]?.config ?? {}) as Record<string, unknown>
    const fromEnv = Object.fromEntries(Object.keys(settings.fields).flatMap((key) => (process.env[envName(name, key)] !== undefined ? [[key, process.env[envName(name, key)]]] : [])))
    return yield* Schema.decodeUnknownEffect(settings)({ ...section, ...fromEnv }, { onExcessProperty: "error" }).pipe(
      Effect.mapError((e) => new ConfigError({ message: `plugins.${name}.config: ${e.message}` })),
    )
  })
