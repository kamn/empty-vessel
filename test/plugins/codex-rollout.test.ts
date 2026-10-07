import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, Logger } from "effect"
import { codexRolloutIdentity, codexSessionMirror, recordCodexUsage } from "../../src/plugins/codex/rollout"

const id = "0194bece-a000-7000-8000-000000000001"
const child = "0194bece-a001-7000-8000-000000000002"
const key = `sessions/${id}`
const ts = 1780000000123
let home: string
let previousHome: string | undefined
const mirror = (role: string, text = "hello", session = key, extra = {}) =>
  codexSessionMirror({ key: session, role, text, ts, extra })
const rows = async (session = key) => (await readFile(codexRolloutIdentity(session).path, "utf8"))
  .trim().split("\n").map((line) => JSON.parse(line))

beforeEach(async () => {
  previousHome = process.env.CODEX_HOME
  home = await mkdtemp(join(tmpdir(), "empty-vessel-codex-rollout-"))
  process.env.CODEX_HOME = home
})
afterEach(async () => {
  if (previousHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

test("UUID start determines identity; metadata uses creation time and private permissions", async () => {
  const before = Date.now()
  await Effect.runPromise(mirror("user"))
  const identity = codexRolloutIdentity(key)
  const start = new Date(parseInt("0194becea000", 16)).toISOString()
  expect(identity.path).toBe(join(home, "sessions", ...start.slice(0, 10).split("-"),
    `rollout-empty-vessel-${start.replaceAll(":", "-")}-${id}.jsonl`))
  const [meta, event] = await rows()
  expect(meta.payload).toEqual({ id, cwd: process.cwd(), originator: "empty-vessel", source: "cli" })
  expect(meta.type).toBe("session_meta")
  expect(Date.parse(meta.timestamp)).toBeGreaterThanOrEqual(before)
  expect(Date.parse(meta.timestamp)).toBeLessThanOrEqual(Date.now())
  expect(event.timestamp).toBe(new Date(ts).toISOString())
  expect((await stat(identity.path)).mode & 0o777).toBe(0o600)
  const raw = await readFile(identity.path, "utf8")
  for (const line of raw.trim().split("\n")) {
    expect(line.startsWith('{"timestamp":')).toBe(true)
    expect(Object.keys(JSON.parse(line)).slice(0, 2)).toEqual(["timestamp", "type"])
    expect(JSON.stringify(JSON.parse(line))).toBe(line)
  }
  expect(Object.keys(event.payload)[0]).toBe("type")
})

test("human and assistant events map exactly; activities never copy text or extras", async () => {
  for (const role of ["user", "steer", "assistant", "step", "command", "check"]) {
    await Effect.runPromise(mirror(role, ["step", "command", "check"].includes(role) ? "SECRET" : role,
      key, { args: "SECRET", output: "SECRET", token: "SECRET" }))
  }
  const all = await rows()
  expect(all.slice(1, 5).map((r) => r.payload)).toEqual([
    { type: "user_message", message: "user", images: [] },
    { type: "user_message", message: "steer", images: [] },
    { type: "agent_message", message: "assistant" },
    { type: "task_complete", last_agent_message: "assistant" },
  ])
  expect(all.slice(5).map((r) => [r.type, r.payload])).toEqual(
    ["step", "command", "check"].map((role) => ["response_item", {
      type: "reasoning", summary: [{ type: "summary_text", text: `empty-vessel activity: ${role}` }],
    }]),
  )
  expect(JSON.stringify(all)).not.toContain("SECRET")
  for (const event of all.slice(1)) expect(Object.keys(event.payload)[0]).toBe("type")
})

test("resume and concurrent appends keep one metadata row and complete batches", async () => {
  await Effect.runPromise(mirror("user", "before resume"))
  const path = codexRolloutIdentity(key).path
  const prefix = await readFile(path, "utf8")
  await Effect.runPromise(Effect.forEach(Array.from({ length: 12 }, (_, i) => i),
    (i) => mirror("assistant", `answer ${i}`), { concurrency: "unbounded" }))
  const all = await rows()
  expect((await readFile(path, "utf8")).startsWith(prefix)).toBe(true)
  expect(all.filter((r) => r.type === "session_meta")).toHaveLength(1)
  expect(all).toHaveLength(26)
  for (let i = 2; i < all.length; i += 2) {
    expect(all[i].payload.type).toBe("agent_message")
    expect(all[i + 1].payload.last_agent_message).toBe(all[i].payload.message)
  }
})

test("empty files recover metadata even with simultaneous first writes", async () => {
  const path = codexRolloutIdentity(key).path
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, "", { mode: 0o600 })
  await Effect.runPromise(Effect.forEach(["one", "two", "three"], (text) => mirror("user", text),
    { concurrency: "unbounded" }))
  const all = await rows()
  expect(all).toHaveLength(4)
  expect(all[0].type).toBe("session_meta")
  expect(all.filter((r) => r.type === "session_meta")).toHaveLength(1)
})

test("children refer to their immediate parent without replaying parent history", async () => {
  await Effect.runPromise(mirror("user", "parent-only"))
  const childKey = `${key}/${child}`
  await Effect.runPromise(mirror("assistant", "child-only", childKey))
  const all = await rows(childKey)
  expect(all).toHaveLength(3)
  expect(all[0].payload.id).toBe(child)
  expect(all[0].payload.source).toBe("cli")
  expect(all[0].payload.empty_vessel_parent_session_id).toBe(id)
  expect(JSON.stringify(all)).not.toContain("parent-only")
  const grandKey = `${childKey}/0194bece-a002-7000-8000-000000000003`
  await Effect.runPromise(mirror("user", "grandchild", grandKey))
  expect((await rows(grandKey))[0].payload.empty_vessel_parent_session_id).toBe(child)
})

test("ignored roles create nothing and credentials are not read or copied", async () => {
  await writeFile(join(home, "auth.json"), "deliberately invalid credential SECRET")
  for (const role of ["project", "resumed", "systemTwo", "command-output", "spawn", "result", "unknown"]) {
    await Effect.runPromise(mirror(role, "SECRET"))
  }
  expect(await readdir(home)).toEqual(["auth.json"])
  await Effect.runPromise(mirror("user", "visible", key, { credentials: "SECRET" }))
  expect(JSON.stringify(await rows())).not.toContain("SECRET")
  expect(await readFile(join(home, "auth.json"), "utf8")).toBe("deliberately invalid credential SECRET")
})

test("usage pairs retain equal calls, model, cached and reasoning counts without cumulative totals", async () => {
  const usage = { input: 100, cached: 25, output: 20, thinking: 7 }
  const before = Date.now()
  await Effect.runPromise(recordCodexUsage(key, "model-a", usage))
  await Effect.runPromise(recordCodexUsage(key, "model-a", usage))
  await Effect.runPromise(recordCodexUsage(key, "model-b", { input: 3, output: 2 }))
  const all = await rows()
  expect(all).toHaveLength(7)
  for (const i of [1, 3, 5]) {
    expect(all[i].type).toBe("turn_context")
    expect(all[i].payload.model).toBe(i === 5 ? "model-b" : "model-a")
    expect(all[i + 1].type).toBe("event_msg")
    expect(all[i + 1].payload.type).toBe("token_count")
    expect(Date.parse(all[i].timestamp)).toBeGreaterThanOrEqual(before)
    expect(Object.keys(all[i + 1].payload.info)).toEqual(["last_token_usage"])
  }
  expect(all[2].payload.info.last_token_usage).toEqual({ input_tokens: 100, cached_input_tokens: 25,
    output_tokens: 20, reasoning_output_tokens: 7, total_tokens: 120 })
  expect(all[4].payload).toEqual(all[2].payload)
  expect(all[6].payload.info.last_token_usage).toEqual({ input_tokens: 3, cached_input_tokens: 0,
    output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 5 })
})

test("invalid UUID versions, variants and traversal keys fail safely without writes", async () => {
  const invalid = ["", "sessions", `other/${id}`, `sessions/../${id}`, `${key}/..`,
    `${key}/`, `sessions//${id}`, `sessions/${id}/../../${child}`,
    key.replace("-7000-", "-4000-"), key.replace("-8000-", "-0000-"),
    `${key}/not-a-uuid`, `sessions/not-a-parent/${child}`, `${key}\\escape`]

  for (const session of invalid) {
    expect(() => codexRolloutIdentity(session)).toThrow("Invalid Codex rollout session key")
    await Effect.runPromise(mirror("user", "ignored", session))
    await Effect.runPromise(recordCodexUsage(session, "model", { input: 1, output: 1 }))
  }

  expect(await readdir(home)).toEqual([])
})

test("lock acquisition defects and append failures cannot break either exporter", async () => {
  const blocker = join(home, "not-a-directory")
  await writeFile(blocker, "unchanged")
  process.env.CODEX_HOME = blocker
  await Effect.runPromise(mirror("user"))
  await Effect.runPromise(recordCodexUsage(key, "model", { input: 1, output: 1 }))
  expect(await readFile(blocker, "utf8")).toBe("unchanged")

  process.env.CODEX_HOME = home
  const path = codexRolloutIdentity(key).path
  await mkdir(path, { recursive: true })
  await Effect.runPromise(mirror("assistant"))
  await Effect.runPromise(recordCodexUsage(key, "model", { input: 1, output: 1 }))
  expect((await stat(path)).isDirectory()).toBe(true)
  expect((await readdir(dirname(path))).some((name) => name.endsWith(".lock"))).toBe(false)
})

test("CODEX_HOME is resolved on each execution, including reusing a constructed effect", async () => {
  const pending = mirror("user")
  await Effect.runPromise(pending)
  const originalPath = codexRolloutIdentity(key).path
  process.env.CODEX_HOME = join(home, "another-home")
  await Effect.runPromise(pending)
  expect(codexRolloutIdentity(key).path).not.toBe(originalPath)
  expect(await rows()).toHaveLength(2)
  expect((await readFile(originalPath, "utf8")).trim().split("\n")).toHaveLength(2)
})

test("filesystem defects produce sanitized warnings rather than leaking details", async () => {
  const warnings: Array<{ level: string; message: unknown }> = []
  const logger = Logger.make((options) => {
    warnings.push({ level: options.logLevel, message: options.message })
  })
  const blocker = join(home, "SECRET-credential-path")
  await writeFile(blocker, "SECRET")
  process.env.CODEX_HOME = blocker

  await Effect.runPromise(Effect.all([
    mirror("user", "SECRET", key, { token: "SECRET" }),
    recordCodexUsage(key, "SECRET", { input: 1, output: 1 }),
  ]).pipe(Effect.provide(Logger.layer([logger]))))

  expect(warnings).toHaveLength(2)
  expect(warnings.every((warning) => warning.level === "Warn")).toBe(true)
  expect(JSON.stringify(warnings)).toContain("Codex rollout export failed")
  expect(JSON.stringify(warnings)).not.toContain("SECRET")
})
