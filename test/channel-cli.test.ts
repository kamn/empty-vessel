import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { CORE_VERSION } from "../src/base/version"

const folders: string[] = []
const temporary = () => { const path = mkdtempSync(join(tmpdir(), "empty-vessel-channel-cli-")); folders.push(path); return path }
afterAll(() => { for (const path of folders) rmSync(path, { recursive: true, force: true }) })
const main = resolve(import.meta.dir, "../src/main.ts")
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("EMPTY_VESSEL_")))

const fixture = (channel = "smoke") => {
  const home = temporary(), project = temporary(), plugin = temporary()
  const state = join(home, "pointer"), messages = join(home, "messages.jsonl")
  writeFileSync(join(plugin, "index.ts"), `
import { Effect, Layer } from "effect"
import { Channel } from "empty-vessel"
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs"
const state = ${JSON.stringify(state)}, messages = ${JSON.stringify(messages)}
let incoming
export default { name: "smoke", core: ${JSON.stringify(CORE_VERSION)}, provides: { channel: Effect.succeed(Layer.succeed(Channel, {
  loadSession: Effect.sync(() => existsSync(state) ? readFileSync(state, "utf8") : undefined),
  saveSession: id => Effect.sync(() => writeFileSync(state, id)),
  send: text => Effect.gen(function* () {
    appendFileSync(messages, JSON.stringify(text) + "\\n")
    if (text === process.env.SMOKE_EXIT_AFTER && incoming) yield* incoming("/exit")
  }),
  listen: receive => Effect.gen(function* () {
    incoming = receive
    for (const text of JSON.parse(process.env.SMOKE_MESSAGES || '["/exit"]')) yield* receive(text)
    yield* Effect.never
  }),
})) } }
`)
  const config = { channel: { use: channel }, systemOne: { use: "fake" }, systemTwo: { use: "fake" }, testOptions: true,
    plugins: { smoke: { path: plugin } } }
  writeFileSync(join(home, "config.json"), JSON.stringify(config))
  const run = (args: string[] = [], env: Record<string, string> = {}, cwd = project) => {
    const child = Bun.spawnSync(["bun", main, ...args], { cwd, env: { ...cleanEnv, EMPTY_VESSEL_HOME: home, ...env }, stdout: "pipe", stderr: "pipe", timeout: 15_000 })
    expect(child.exitCode).toBe(0)
    return child.stdout.toString() + child.stderr.toString()
  }
  const sent = () => existsSync(messages) ? readFileSync(messages, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string) : []
  return { home, project, state, messages, run, sent }
}

test("CLI starts an outside channel, persists its session, and resumes on relaunch", () => {
  const f = fixture()
  expect(f.run()).not.toContain("Error")
  const key = readFileSync(f.state, "utf8")
  expect(key).toMatch(/^sessions\//)
  expect(f.sent()[0]).toContain("Started session")
  expect(f.sent().at(-1)).toContain("Channel stopped")
  f.run()
  expect(readFileSync(f.state, "utf8")).toBe(key)
  expect(f.sent().some((text) => text.startsWith("Resumed session"))).toBe(true)
  f.run(["--resume", key.slice("sessions/".length)])
  expect(readFileSync(f.state, "utf8")).toBe(key)
}, 30_000)

test("a channel message runs the real turn with fake providers and persists its answer", () => {
  const f = fixture()
  f.run([], { SMOKE_MESSAGES: JSON.stringify(["channel smoke"]), SMOKE_EXIT_AFTER: "echo: channel smoke" })
  expect(f.sent()).toContain("echo: channel smoke")
  const key = readFileSync(f.state, "utf8")
  const entries = readFileSync(join(f.home, key, "main.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
  expect(entries.some((entry) => entry.role === "user" && entry.text === "channel smoke")).toBe(true)
  expect(entries.some((entry) => entry.role === "assistant" && entry.text === "echo: channel smoke")).toBe(true)
})

test("CLI channel resume rejects another project before sending any messages", () => {
  const f = fixture()
  f.run()
  const before = f.sent()
  expect(f.run([], {}, temporary())).toContain("belongs to another project")
  expect(f.sent()).toEqual(before)
})

test("malformed session metadata fails clearly instead of crashing or creating a replacement", () => {
  const f = fixture()
  f.run()
  const key = readFileSync(f.state, "utf8")
  const before = f.sent()
  writeFileSync(join(f.home, key, "main.jsonl"), JSON.stringify({ role: "project", text: 42 }) + "\n")
  expect(f.run()).toContain("session is missing or belongs to another project")
  expect(f.sent()).toEqual(before)
  expect(readFileSync(f.state, "utf8")).toBe(key)
})

test("one-shot remains terminal-only even with unconfigured Telegram selected", () => {
  const f = fixture("telegram")
  const output = f.run(["-p", "hello from terminal"])
  expect(output).toContain("hello from terminal")
  expect(output).not.toContain("plugins.telegram.config")
  expect(output).not.toContain("channel:")
  expect(existsSync(f.state)).toBe(false)
})

test("Telegram startup reports missing settings without polling; doctor validates redacted settings", () => {
  const f = fixture("telegram")
  expect(f.run()).toContain("plugins.telegram.config")
  const token = "123456:LOCAL_TEST_SECRET"
  const output = f.run(["doctor"], { EMPTY_VESSEL_TELEGRAM_TOKEN: token, EMPTY_VESSEL_TELEGRAM_ALLOWED_USER_ID: "42", EMPTY_VESSEL_TELEGRAM_ALLOWED_CHAT_ID: "42" })
  expect(output).toContain("telegram")
  expect(output).toContain("<redacted>")
  expect(output).not.toContain(token)
  expect(existsSync(join(f.home, "telegram"))).toBe(false)
})

test("doctor reports a malformed token without printing it or contacting Telegram", () => {
  const f = fixture("telegram")
  const token = "MALFORMED_LOCAL_SECRET"
  const output = f.run(["doctor"], { EMPTY_VESSEL_TELEGRAM_TOKEN: token, EMPTY_VESSEL_TELEGRAM_ALLOWED_USER_ID: "42", EMPTY_VESSEL_TELEGRAM_ALLOWED_CHAT_ID: "42" })
  expect(output).toContain("Expected a BotFather token")
  expect(output).not.toContain(token)
  expect(existsSync(join(f.home, "telegram"))).toBe(false)
})

test("terminal override bypasses channel startup and unknown channels fail clearly", () => {
  const f = fixture("missing-channel")
  expect(f.run()).toContain('channel.use is "missing-channel"')
  expect(f.run(["-p", "terminal override"], { EMPTY_VESSEL_CHANNEL: "terminal" })).toContain("terminal override")
})
