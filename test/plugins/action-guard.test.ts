import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { ActionGuard, withActionGuard, type Action } from "../../src/tools/action-guard"
import { Config, ConfigSchema } from "../../src/base/config"
import { CORE_VERSION } from "../../src/base/version"
import { ActionGuardFromConfig } from "../../src/plugins/index"
import { kindsOf, loadOutside, removePlugin } from "../../src/plugins/outside"
import { FakeSystemOne } from "../../src/system-one/systemone"

const folders: string[] = []
afterAll(() => { for (const folder of folders) rmSync(folder, { recursive: true, force: true }) })
const folder = () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "empty-vessel-action-guard-")))
  folders.push(path)
  return path
}
const provider = (name: string, body: string, kind = "actionGuard") => {
  const path = folder()
  writeFileSync(join(path, "index.ts"), `
import { Effect, Layer, Schema } from "effect"
import { ActionGuard, PluginError, SystemOne, described, setting, pluginSettings, type Plugin } from "empty-vessel"
const settings = described({ reason: setting(Schema.String, "Why this guard refuses", { default: "blocked" }) })
export default { name: ${JSON.stringify(name)}, core: ${JSON.stringify(CORE_VERSION)}, settings,
  provides: { ${kind}: ${body} }
} satisfies Plugin
`)
  return path
}
const action: Action = { kind: "shell", command: "echo hello", cwd: "/tmp", timeoutMs: 1000 }
const run = (raw: unknown, proposed = action) => Effect.gen(function* () {
  return yield* (yield* ActionGuard).beforeAction(proposed)
}).pipe(
  Effect.provide(ActionGuardFromConfig),
  Effect.provide(FakeSystemOne),
  Effect.provideService(Config, Schema.decodeUnknownSync(ConfigSchema)(raw)),
)
const verdict = (decision: "allow" | "deny" | "ask" | "revise") =>
  `Effect.succeed(Layer.succeed(ActionGuard, { beforeAction: () => Effect.succeed({ decision: "${decision}", reason: "${decision}" }) }))`

test("no configured guards defaults to allow", async () => {
  expect(Schema.decodeUnknownSync(ConfigSchema)({}).actionGuard.use).toEqual([])
  expect(await Effect.runPromise(run({}))).toEqual({ decision: "allow" })
})

test("selected outside guard reads plugin config and captures SystemOne during layer construction", async () => {
  const path = provider("policy", `Effect.gen(function* () {
    const config = yield* pluginSettings("policy", settings)
    return Layer.effect(ActionGuard, Effect.gen(function* () {
      const one = yield* SystemOne
      return { beforeAction: () => Effect.succeed({ decision: "deny" as const, reason: config.reason + (one ? " via SystemOne" : "") }) }
    }))
  })`)
  expect(await Effect.runPromise(run({ actionGuard: { use: ["policy"] }, plugins: { policy: { path, config: { reason: "custom" } } } })))
    .toEqual({ decision: "deny", reason: "custom via SystemOne" })
})

test("unknown, wrong-kind, disabled, and unloadable selected guards fail initialization", async () => {
  const disabled = provider("disabled", verdict("allow"))
  for (const raw of [
    { actionGuard: { use: ["missing"] } },
    { actionGuard: { use: ["fake"] } },
    { actionGuard: { use: ["disabled"] }, plugins: { disabled: { path: disabled, enabled: false } } },
    { actionGuard: { use: ["broken"] }, plugins: { broken: { path: "/nonexistent/action-guard-plugin.ts" } } },
  ]) {
    const error = await Effect.runPromise(run(raw).pipe(Effect.flip))
    expect(error).toMatchObject({ _tag: "ConfigError" })
    expect((error as { message: string }).message).toContain("actionGuard.use")
  }
})

test("selected guards compose without allow overriding deny in either order", async () => {
  const plugins = { allow: { path: provider("allow", verdict("allow")) }, deny: { path: provider("deny", verdict("deny")) } }
  for (const use of [["deny", "allow"], ["allow", "deny"]]) {
    expect(await Effect.runPromise(run({ actionGuard: { use }, plugins }))).toEqual({ decision: "deny", reason: "deny" })
  }
})

test("a selected layer that does not provide ActionGuard fails closed", async () => {
  const path = provider("empty", "Effect.succeed(Layer.empty)")
  const error = await Effect.runPromise(run({ actionGuard: { use: ["empty"] }, plugins: { empty: { path } } }).pipe(Effect.flip))
  expect(error).toMatchObject({ _tag: "ConfigError", message: expect.stringContaining("did not provide ActionGuard") })
})

test("guard config and layer initialization failures propagate", async () => {
  const badConfig = provider("policy", `Effect.gen(function* () {
    yield* pluginSettings("policy", settings)
    return Layer.succeed(ActionGuard, { beforeAction: () => Effect.succeed({ decision: "allow" }) })
  })`)
  const failed = provider("failed", `Effect.succeed(Layer.effect(ActionGuard, Effect.fail(new PluginError({ what: "failed", message: "cannot start guard" }))))`)
  expect(await Effect.runPromise(run({ actionGuard: { use: ["policy"] }, plugins: { policy: { path: badConfig, config: { reason: 42 } } } }).pipe(Effect.flip)))
    .toMatchObject({ _tag: "ConfigError" })
  expect(await Effect.runPromise(run({ actionGuard: { use: ["failed"] }, plugins: { failed: { path: failed } } }).pipe(Effect.flip)))
    .toMatchObject({ _tag: "PluginError", message: "cannot start guard" })
})

test("outside plugin validation accepts actionGuard and rejects unknown kinds", async () => {
  const [accepted, rejected] = await Effect.runPromise(loadOutside({
    valid: { path: provider("valid", verdict("allow")) },
    invalid: { path: provider("invalid", verdict("allow"), "notAKind") },
  }, []))
  expect(accepted && "plugin" in accepted ? kindsOf(accepted.plugin) : undefined).toBe("action guard")
  expect(rejected && "error" in rejected ? rejected.error : undefined).toContain("unknown plugin kind")
})

test("removing a selected action guard warns that config still requires it", () => {
  const file = join(folder(), "config.json")
  writeFileSync(file, JSON.stringify({ actionGuard: { use: ["policy"] }, plugins: { policy: { path: "/some/plugin", config: { reason: "keep" } } } }))
  expect(removePlugin(file, "policy")).toEqual(["actionGuard"])
})


test("bundled no-absolute-rm is selectable without an outside plugin", async () => {
  const config = { actionGuard: { use: ["no-absolute-rm"] } }
  expect(await Effect.runPromise(run(config, { ...action, command: "rm -rf /tmp/folder" })))
    .toMatchObject({ decision: "deny" })
  expect(await Effect.runPromise(run(config, { ...action, command: "rm -rf ./tmp/folder" })))
    .toEqual({ decision: "allow" })
})


test("configured no-absolute-rm stops execution at the guard boundary", async () => {
  let executed = false
  const proposed: Action = { ...action, command: "rm -rf /tmp/folder" }
  // A harmless spy stands in for execution. Never run deletion snippets in tests.
  const output = await Effect.runPromise(withActionGuard(proposed, Effect.sync(() => {
    executed = true
    return "exit 0"
  })).pipe(
    Effect.provide(ActionGuardFromConfig),
    Effect.provide(FakeSystemOne),
    Effect.provideService(Config, Schema.decodeUnknownSync(ConfigSchema)({ actionGuard: { use: ["no-absolute-rm"] } })),
  ))
  expect(executed).toBe(false)
  expect(output).toContain("ActionGuard deny")
  expect(output).toContain("/tmp/folder")
})
