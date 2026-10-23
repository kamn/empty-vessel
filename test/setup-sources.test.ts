import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { PluginSetup } from "../src/base/plugin-setup"
import { runSetup } from "../src/setup"

// The browser preset: setup offers Playwright MCP as the `browser` source. Config shape only; npx never runs.
const alpha: PluginSetup = { name: "alpha", kind: "systemTwo", title: "Alpha" }
const PLAYWRIGHT = { command: "npx", args: ["@playwright/mcp@latest", "--isolated", "--headless"] }

const run = async (file: string, answer: string) => {
  const asked: Array<string> = []
  await Effect.runPromise(runSetup(file, [alpha], { ask: (q) => { asked.push(q); return /browser/i.test(q) ? answer : "" }, say: () => Effect.void }))
  return { config: JSON.parse(readFileSync(file, "utf8")), asked: asked.join("\n") }
}
const fresh = () => join(mkdtempSync(join(tmpdir(), "empty-vessel-setup-")), "config.json")

test("yes writes the Playwright source; running setup again doesn't ask or duplicate it", async () => {
  const file = fresh()
  const first = await run(file, "y")
  expect(first.config.sources).toEqual({ browser: PLAYWRIGHT })

  const again = await run(file, "y")
  expect(again.asked).not.toMatch(/browser/i)
  expect(again.config.sources).toEqual({ browser: PLAYWRIGHT })
})

test("Enter skips it; other sources are kept", async () => {
  const skipped = await run(fresh(), "")
  expect(skipped.config.sources).toBeUndefined()

  const file = fresh()
  writeFileSync(file, JSON.stringify({ sources: { posthog: { url: "https://mcp.example" } } }))
  const added = await run(file, "yes")
  expect(added.config.sources).toEqual({ posthog: { url: "https://mcp.example" }, browser: PLAYWRIGHT })
})

test("a browser source you edited is left alone", async () => {
  const file = fresh()
  const mine = { command: "npx", args: ["@playwright/mcp@latest", "--browser", "firefox"] }
  writeFileSync(file, JSON.stringify({ sources: { browser: mine } }))
  const { config, asked } = await run(file, "y")
  expect(asked).not.toMatch(/browser/i)
  expect(config.sources.browser).toEqual(mine)
})

// Desktop control: macos-automator-mcp as the `desktop` source, asking before every call; only on a Mac, only on yes.
const DESKTOP = { command: "npx", args: ["-y", "@steipete/macos-automator-mcp@latest"], ask: true }
const desktop = async (file: string, answer: string, platform: string) => {
  const asked: Array<string> = [], said: Array<string> = []
  await Effect.runPromise(runSetup(file, [alpha], { ask: (q) => { asked.push(q); return /desktop/i.test(q) ? answer : "" }, say: (l) => Effect.sync(() => { said.push(l) }) }, platform))
  return { config: JSON.parse(readFileSync(file, "utf8")), asked: asked.join("\n"), said: said.join("\n") }
}

test("desktop control: yes on a Mac adds it with ask and says what to allow; again, it isn't asked or duplicated", async () => {
  const file = fresh()
  const first = await desktop(file, "y", "darwin")
  expect(first.config.sources).toEqual({ desktop: DESKTOP })
  expect(first.said).toMatch(/Accessibility/)
  expect(first.said).toMatch(/Docker/)

  const again = await desktop(file, "y", "darwin")
  expect(again.asked).not.toMatch(/desktop/i)
  expect(again.config.sources).toEqual({ desktop: DESKTOP })
})

test("desktop control is off by default, and never offered off a Mac", async () => {
  expect((await desktop(fresh(), "", "darwin")).config.sources).toBeUndefined()

  const linux = await desktop(fresh(), "y", "linux")
  expect(linux.asked).not.toMatch(/desktop/i)
  expect(linux.config.sources).toBeUndefined()
})
