import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { PluginSetup } from "../src/base/plugin-setup"
import { runSetup } from "../src/setup"

// Stand-in plugins: a judge that asks for a key (tested), and two System Twos with checks.
const judge: PluginSetup = { name: "judge", kind: "systemOne", title: "A judge", asks: [{ setting: "apiKey", prompt: "Judge key", secret: true, test: (k) => Effect.succeed(k === "good-key"), failed: "refused" }] }
const alpha = (ready: boolean): PluginSetup => ({ name: "alpha", kind: "systemTwo", title: "Alpha", checks: [{ what: "alpha's CLI", ok: Effect.succeed(ready), fix: "install alpha" }], defaults: { model: "alpha-1" } })
const beta = (ready: boolean): PluginSetup => ({ name: "beta", kind: "systemTwo", title: "Beta", checks: [{ what: "beta's login", ok: Effect.succeed(ready), fix: "log in to beta" }] })

// Setup with scripted answers; returns the config written and everything said.
const setUp = async (setups: ReadonlyArray<PluginSetup>, answers: ReadonlyArray<string>, before?: object) => {
  const file = join(mkdtempSync(join(tmpdir(), "empty-vessel-setup-")), "config.json")
  if (before) writeFileSync(file, JSON.stringify(before))
  const said: Array<string> = [], asked: Array<string> = [], queue = [...answers]
  await Effect.runPromise(runSetup(file, setups, { ask: (q) => { asked.push(q); return queue.shift() ?? "" }, say: (l) => Effect.sync(() => { said.push(l) }) }))
  return { config: JSON.parse(readFileSync(file, "utf8")), said: said.join("\n"), asked: asked.join("\n"), mode: statSync(file).mode & 0o777 }
}

test("each plugin's checks and questions; the ready one of each kind is chosen; its defaults written; the key never printed", async () => {
  const { config, said, mode } = await setUp([judge, alpha(true), beta(false)], ["good-key"])
  expect(config).toEqual({
    systemOne: { use: "judge" },
    systemTwo: { reasoning: "medium", use: "alpha" },
    plugins: { judge: { config: { apiKey: "good-key" } }, alpha: { config: { model: "alpha-1" } } },
  })
  expect(said).toContain("✓ alpha's CLI")
  expect(said).toContain("✗ beta's login: log in to beta")
  expect(said).not.toContain("good-key")
  expect(mode).toBe(0o600)
})

test("several ready: asked which (a number, or Enter keeping the current one)", async () => {
  const two = await setUp([judge, alpha(true), beta(true)], ["", "2"])
  expect(two.asked).toContain("System Two: which one?")
  expect(two.config.systemTwo.use).toBe("beta")
  const kept = await setUp([judge, alpha(true), beta(true)], ["", ""], { systemTwo: { use: "beta" } })
  expect(kept.config.systemTwo.use).toBe("beta")
})

test("a key that fails its test isn't saved (none: the fake); Enter keeps a key already there", async () => {
  const refused = await setUp([judge, alpha(true)], ["bad-key"])
  expect(refused.said).toContain("✗ refused")
  expect(refused.config.systemOne.use).toBe("fake")
  expect(refused.config.plugins?.judge).toBeUndefined()

  const kept = await setUp([judge, alpha(true)], [""], { systemOne: { use: "judge" }, plugins: { judge: { config: { apiKey: "good-key" } } } })
  expect(kept.config.systemOne.use).toBe("judge")
  expect(kept.config.plugins.judge.config.apiKey).toBe("good-key")
})

test("an older config comes out in today's shape, other settings kept; a choice setup doesn't manage (jev-mock) is left alone", async () => {
  const { config } = await setUp([alpha(false)], [], { ui: "tui", systemOne: { use: "jev-mock", apiKey: "old-key" }, systemTwo: { use: "alpha", model: "m" } })
  expect(config.ui).toBe("tui")
  expect(config.systemOne).toEqual({ use: "jev-mock" })
  expect(config.plugins.jev.config.apiKey).toBe("old-key")          // moved from systemOne.apiKey
  expect(config.systemTwo.use).toBe("fake")                          // alpha isn't ready any more
})


test("channel setup is optional, preserves existing choices, and does not force the sole provider", async () => {
  const channel: PluginSetup = { name: "chat", kind: "channel", title: "Chat", asks: [{ setting: "token", prompt: "Chat token" }] }
  const skipped = await setUp([channel], [""])
  expect(skipped.config.channel).toBeUndefined()
  expect(skipped.asked).not.toContain("Chat token")
  const kept = await setUp([channel], [""], { channel: { use: "outside", extra: true } })
  expect(kept.config.channel).toEqual({ use: "outside", extra: true })
  const terminal = await setUp([channel], ["yes", "token", ""])
  expect(terminal.config.channel).toBeUndefined()
  const selected = await setUp([channel], ["yes", "token", "chat"])
  expect(selected.config.channel).toEqual({ use: "chat" })
  expect(selected.config.plugins.chat.config.token).toBe("token")
})
