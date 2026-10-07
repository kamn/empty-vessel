import type { Effect } from "effect"

// What a plugin needs before it can be used, for `empty-vessel setup`: what it checks on this
// machine, and what it asks for. Each bundled plugin says so in its own src/plugins/<name>/setup.ts; setup walks
// through them all and knows none of them.

export type SetupCheck = {
  readonly what: string                   // "the Codex CLI"
  readonly ok: Effect.Effect<boolean>
  readonly fix: string                    // what to do if it isn't: "install it: https://…"
}

export type SetupAsk = {
  readonly setting: string                // saved as plugins.<name>.config.<setting>
  readonly prompt: string                 // "Jev API key"
  readonly secret?: boolean               // never printed back
  readonly optional?: boolean             // skipping it still leaves the plugin ready (a local server needs no key)
  // does it work? (a key tried once), given the plugin's settings so far; a value that doesn't isn't saved
  readonly test?: (value: string, settings: Readonly<Record<string, unknown>>) => Effect.Effect<boolean>
  readonly failed?: string                // said when the test fails
  // the values it can be (the models a server has), listed to pick by number; none (or none found): typed freely
  readonly choices?: (settings: Readonly<Record<string, unknown>>) => Effect.Effect<ReadonlyArray<string>>
}

export type PluginSetup = {
  readonly name: string                   // its name in the config: systemOne.use / systemTwo.use
  readonly kind: "systemOne" | "systemTwo" | "channel"
  readonly title: string                  // "Jev, from TypeSafe AI"
  readonly about?: string                 // where to get it
  readonly checks?: ReadonlyArray<SetupCheck>
  readonly asks?: ReadonlyArray<SetupAsk>
  readonly defaults?: Readonly<Record<string, unknown>> // written into its settings when it's chosen, unless already set
}
