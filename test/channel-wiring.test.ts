import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { ConfigSchema } from "../src/base/config"
import { CORE_VERSION } from "../src/base/version"

const run = (config: object, script: string, override = "") => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-channel-"))
  writeFileSync(join(home, "config.json"), JSON.stringify(config))
  const result = Bun.spawnSync(["bun", "-e", script], { cwd: join(import.meta.dir, ".."), env: { ...process.env, EMPTY_VESSEL_HOME: home, EMPTY_VESSEL_CHANNEL: override }, stdout: "pipe", stderr: "pipe" })
  expect(result.exitCode).toBe(0)
  return result.stdout.toString().trim()
}

test("channel defaults to terminal; environment overrides the file", () => {
  expect(Schema.decodeUnknownSync(ConfigSchema)({}).channel.use).toBe("terminal")
  const script = 'import { Effect } from "effect"; import { Config } from "./src/base/config"; console.log(await Effect.runPromise(Config.pipe(Effect.map(c => c.channel.use), Effect.provide(Config.layer))))'
  expect(run({ channel: { use: "saved" } }, script)).toBe("saved")
  expect(run({ channel: { use: "saved" } }, script, "override")).toBe("override")
})


test("registry builds a channel and retains typed startup errors", () => {
  const script =
    'import { Effect, Layer } from "effect"; import { Config, Channel, PluginError } from "./src/core"; import { PLUGINS, ChannelFromConfig } from "./src/plugins/index";' +
    'PLUGINS.push({ name: "test-channel", provides: { channel: Effect.succeed(Layer.succeed(Channel, { loadSession: Effect.succeed("session"), saveSession: () => Effect.void, send: () => Effect.void, listen: () => Effect.void })) } });' +
    'console.log(await Effect.runPromise(Channel.pipe(Effect.flatMap(c => c.loadSession), Effect.provide(ChannelFromConfig), Effect.provide(Config.layer))));' +
    'PLUGINS.push({ name: "broken", provides: { channel: Effect.succeed(Layer.effect(Channel, Effect.fail(new PluginError({ what: "channel", message: "startup" })))) } });' +
    'const config = await Effect.runPromise(Config.pipe(Effect.provide(Config.layer)));' +
    'console.log(await Effect.runPromise(Layer.build(ChannelFromConfig).pipe(Effect.scoped, Effect.provideService(Config, { ...config, channel: { use: "broken" } }), Effect.catch(e => Effect.succeed(e._tag + ":" + e.message)))));'
  expect(run({ channel: { use: "test-channel" } }, script)).toBe("session\nPluginError:startup")
})

test("unknown channels fail clearly; doctor accepts terminal and flags unknown channels", () => {
  const build = 'import { Effect, Layer } from "effect"; import { Config } from "./src/core"; import { ChannelFromConfig } from "./src/plugins/index"; console.log(await Effect.runPromise(Layer.build(ChannelFromConfig).pipe(Effect.scoped, Effect.provide(Config.layer), Effect.catch(e => Effect.succeed(e.message)))))'
  expect(run({ channel: { use: "missing" } }, build)).toContain('channel.use is "missing"')
  const doctor = 'import { Effect } from "effect"; import { Config } from "./src/core"; import { doctor } from "./src/doctor"; await Effect.runPromise(doctor.pipe(Effect.provide(Config.layer)))'
  expect(run({ channel: { use: "terminal" } }, doctor)).not.toContain("✗")
  expect(run({ channel: { use: "missing" } }, doctor)).toContain('channel.use is "missing"')
})


test("outside channel providers load, disabled providers do not, and removal reports channel use", () => {
  const folder = mkdtempSync(join(tmpdir(), "empty-vessel-outside-channel-"))
  const path = join(folder, "index.ts")
  writeFileSync(path, 'import { Effect, Layer } from "effect"; import { Channel } from "empty-vessel"; export default { name: "outside-chat", core: ' + JSON.stringify(CORE_VERSION) + ', provides: { channel: Effect.succeed(Layer.succeed(Channel, { loadSession: Effect.succeed("outside-session"), saveSession: () => Effect.void, send: () => Effect.void, listen: () => Effect.void })) } }')
  const config = { channel: { use: "outside-chat" }, plugins: { "outside-chat": { path } } }
  const script = 'import { Effect } from "effect"; import { Config, Channel } from "./src/core"; import { ChannelFromConfig } from "./src/plugins/index"; console.log(await Effect.runPromise(Channel.pipe(Effect.flatMap(c => c.loadSession), Effect.provide(ChannelFromConfig), Effect.provide(Config.layer), Effect.catch(e => Effect.succeed(e.message)))))'
  expect(run(config, script)).toBe("outside-session")
  expect(run({ ...config, plugins: { "outside-chat": { path, enabled: false } } }, script)).toContain('no plugin provides a channel')
  expect(run({ ...config, plugins: { "outside-chat": { path: join(folder, "missing.ts") } } }, script)).toContain("a plugin that didn't load")
  const remove = 'import { removePlugin } from "./src/plugins/outside"; console.log(JSON.stringify(removePlugin(process.env.EMPTY_VESSEL_HOME + "/config.json", "outside-chat")))'
  expect(run(config, remove)).toBe('["channel"]')
})
