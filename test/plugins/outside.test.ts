import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Config, ConfigSchema } from "../../src/base/config"
import { CORE_VERSION } from "../../src/base/version"
import { fitsCore } from "../../src/plugins/outside"
import { SystemTwoFromConfig } from "../../src/plugins/index"
import { SystemTwo } from "../../src/system-two/systemtwo"

// An outside repo: its own folder and package.json, no node_modules, a plugin that imports "empty-vessel" and "effect" by name
// and provides a System Two of the model kind (a stand-in model that answers without tools).
const minor = CORE_VERSION // what an outside plugin says it works with
const outsideRepo = (name: string, core: string | undefined) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "empty-vessel-outside-")))
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `empty-vessel-plugin-${name}`, type: "module", main: "src/plugin.ts" }))
  mkdirSync(join(dir, "src"))
  writeFileSync(join(dir, "src/plugin.ts"), `import { Effect } from "effect"
import { type Model, modelParts, type Plugin } from "empty-vessel"

const model: Model = {
  name: "${name}",
  complete: (request) => Effect.succeed({ text: \`hello from outside (\${request.tools.length} tools offered)\`, calls: [], keep: [], thinking: "", searches: [], usage: { input: 1, cached: 0, output: 1, thinking: 0 } }),
}

const plugin: Plugin = {
  name: "${name}",
  ${core === undefined ? "" : `core: "${core}",`}
  provides: { systemTwo: Effect.succeed({ ...modelParts(model, model, 5), describe: { long: "${name} (outside)", short: "${name}" } }) },
}
export default plugin
`)
  return dir
}

// empty-vessel configured to use it as System Two, asked one thing.
const ask = (name: string, path: string) => {
  const config = Schema.decodeUnknownSync(ConfigSchema)({ systemTwo: { use: name }, plugins: { [name]: { path } } })
  return Effect.runPromise(SystemTwo.use((s) => s.ask("hi")).pipe(
    Effect.provide(SystemTwoFromConfig), Effect.provide(Layer.succeed(Config, config)), Effect.map((r) => r.text), Effect.catch((e) => Effect.succeed(`failed: ${(e as { message?: string }).message ?? e}`)),
  ))
}

test("a plugin from an outside repo, configured by path, is empty-vessel's System Two: it shares empty-vessel's Effect and core", async () => {
  const repo = outsideRepo("echo", minor)
  expect(await ask("echo", repo)).toBe("hello from outside (6 tools offered)")
  expect(existsSync(join(repo, "node_modules/empty-vessel/src/core.ts"))).toBe(true) // linked to empty-vessel's own copies
  expect(existsSync(join(repo, "node_modules/effect"))).toBe(true)
})

test("an outside plugin for another core, without a core, under another name, or missing, is refused, saying why", async () => {
  expect(await ask("older", outsideRepo("older", "0.1"))).toContain(`works with core 0.1; this is ${CORE_VERSION}`)
  expect(await ask("vague", outsideRepo("vague", undefined))).toContain("doesn't say which cores it works with")
  expect(await ask("other", outsideRepo("echo2", minor))).toContain(`is the plugin "echo2", not "other"`)
  expect(await ask("ghost", join(tmpdir(), "no-such-plugin-here"))).toContain("can't load it from")
})

test("which cores a plugin fits: a semver range, one version, a range or several", () => {
  expect([fitsCore("0.0.8", "0.0.8"), fitsCore("0.0.8", "0.0.9"), fitsCore("^0.0.8", "0.0.9")]).toEqual([true, false, false])
  expect([fitsCore(">=0.0.5 <=0.0.9", "0.0.7"), fitsCore(">=0.0.5 <=0.0.9", "0.0.10")]).toEqual([true, false])
  expect([fitsCore("0.0.5 || 0.0.7", "0.0.7"), fitsCore("0.0.5 || 0.0.7", "0.0.6")]).toEqual([true, false])
})

// The commands, as a user runs them, in a home of their own: add, list, doctor, setup, remove. The plugin has settings
// and a setup check, so doctor and setup have something of its to show.
test("empty-vessel plugins add, list and remove; doctor and setup include an outside plugin", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "empty-vessel-outside-home-")))
  const repo = outsideRepo("greeter", minor)
  writeFileSync(join(repo, "src/plugin.ts"), `import { Effect, Schema } from "effect"
import { described, type Model, modelParts, type Plugin, pluginSettings, setting } from "empty-vessel"

const settings = described({ greeting: setting(Schema.String, "What the greeter says") })
const model = (greeting: string): Model => ({
  name: "greeter",
  complete: () => Effect.succeed({ text: greeting, calls: [], keep: [], thinking: "", searches: [], usage: { input: 1, cached: 0, output: 1, thinking: 0 } }),
})
const plugin: Plugin = {
  name: "greeter", core: "${minor}", settings,
  setup: { name: "greeter", kind: "systemTwo", title: "Greeter, from outside", checks: [{ what: "a friendly mood", ok: Effect.succeed(true), fix: "smile" }] },
  provides: { systemTwo: Effect.gen(function* () {
    const { greeting } = yield* pluginSettings("greeter", settings)
    return { ...modelParts(model(greeting), model(greeting), 5), describe: { long: "greeter", short: "greeter" } }
  }) },
}
export default plugin
`)
  const emptyVessel = (args: ReadonlyArray<string>, input = "") => {
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "../../src/main.ts"), ...args], { cwd: home, env: { ...process.env, EMPTY_VESSEL_HOME: home, OPENROUTER_API_KEY: "" }, stdin: new TextEncoder().encode(input) })
    return r.stdout.toString() + r.stderr.toString()
  }
  writeFileSync(join(home, "config.json"), JSON.stringify({ systemOne: { use: "fake" }, systemTwo: { use: "fake" } }))

  expect(emptyVessel(["plugins", "add", repo])).toContain(`Added greeter (system two, for core ${minor})`)
  const config = JSON.parse(require("node:fs").readFileSync(join(home, "config.json"), "utf8"))
  expect(config.plugins.greeter.path).toBe(repo)
  expect(emptyVessel(["plugins", "list"])).toMatch(new RegExp(`greeter\\s+system two\\s+${repo}`))
  expect(emptyVessel(["plugins", "add", repo + "-nope"])).toContain("plugins add: can't load it from")

  // doctor: its settings (missing until set, fine while not in use), then set and in use.
  const unset = emptyVessel(["doctor"])
  expect(unset).toContain("· greeter (outside, not in use): plugins.greeter.config: Missing key")
  expect(unset).toContain("greeting: What the greeter says") // doctor says what the missing setting is
  writeFileSync(join(home, "config.json"), JSON.stringify({ ...config, systemTwo: { use: "greeter" }, plugins: { greeter: { ...config.plugins.greeter, config: { greeting: "hello" } } } }))
  const doctor = emptyVessel(["doctor"])
  expect(doctor).toContain("✓ greeter (outside, in use): greeting hello")
  expect(doctor).toContain("✓ greeter: a friendly mood")
  expect(emptyVessel(["-p", "hi"])).toContain("hello") // and it answers as System Two

  // setup offers it among the System Twos, with its check.
  expect(emptyVessel(["setup"], "\n".repeat(12))).toContain("Greeter, from outside")

  expect(emptyVessel(["plugins", "remove", "greeter"])).toContain("Removed greeter (its settings stay). systemTwo still uses it")
  expect(emptyVessel(["plugins", "remove", "greeter"])).toContain("No outside plugin named greeter.")
}, 120_000)

// One Effect: a plugin's own copy is refused (never deleted), a stale link re-pointed, a dependency's copy refused.
test("an outside plugin's own Effect: its installed copy or a dependency's is refused and kept; a stale link is re-pointed", async () => {
  const fakeEffect = (dir: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "effect", version: "3.0.0" })) }

  const own = outsideRepo("own", minor)
  fakeEffect(join(own, "node_modules/effect"))
  expect(await ask("own", own)).toContain("it has its own copy of effect (node_modules/effect): list effect as a peerDependency")
  expect(existsSync(join(own, "node_modules/effect/package.json"))).toBe(true) // kept

  const stale = outsideRepo("stale", minor)
  mkdirSync(join(stale, "node_modules"))
  require("node:fs").symlinkSync(tmpdir(), join(stale, "node_modules/effect"))
  expect(await ask("stale", stale)).toBe("hello from outside (6 tools offered)")
  expect(realpathSync(join(stale, "node_modules/effect"))).toBe(realpathSync(join(import.meta.dir, "../../node_modules/effect")))

  const nested = outsideRepo("nested", minor)
  fakeEffect(join(nested, "node_modules/@acme/helper/node_modules/effect"))
  expect(await ask("nested", nested)).toContain("its dependencies bring their own copy of Effect (node_modules/@acme/helper/node_modules/effect 3.0.0)")
})

// Every setting says what it is: a plugin whose settings skip setting() (JavaScript skips the types) is refused.
test("an outside plugin whose settings don't say what they are is refused, naming them", async () => {
  const repo = outsideRepo("vague", minor)
  writeFileSync(join(repo, "src/plugin.ts"), `import { Effect, Schema } from "effect"
export default { name: "vague", core: "${minor}", settings: Schema.Struct({ color: Schema.String, size: Schema.Number }), provides: { systemTwo: Effect.die("unused") } }
`)
  expect(await ask("vague", repo)).toContain("vague's settings don't say what they are: color, size (make each with setting(schema, description)")
})
