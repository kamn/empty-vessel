import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { CurrentSession, type SessionHandle } from "../../src/base/session"

if (process.env.CODEX_DURABLE_TEST !== "1") throw new Error("Run the codex-durable-usage.test.ts wrapper")
// No credential file is opened. This mock is isolated in the wrapper's subprocess.
mock.module("../../src/plugins/codex/auth", () => ({
  readCodexAuth: Effect.succeed({ token: Redacted.make("fake-test-token"), accountId: "mock", expires: 9999999999000 }),
}))
globalThis.fetch = Object.assign(() => { throw new Error("Network forbidden") }, {
  preconnect: () => { throw new Error("Network forbidden") },
})
const { codexModel } = await import("../../src/plugins/codex/codex")
const { codexRolloutIdentity, recordCodexUsage } = await import("../../src/plugins/codex/rollout")
const home = await mkdtemp(join(tmpdir(), "codex-durable-"))
process.env.CODEX_HOME = home
const root = "sessions/0194bece-a000-7000-8000-000000000001"
const child = `${root}/0194bece-a001-7000-8000-000000000002`
const request = { instructions: "test", thread: [], tools: [] }
const counts = { input: 100, cached: 60, output: 25, thinking: 10 }
const usage = { input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 10 } }
const records: Array<{ key: string; role: string; extra: any }> = []
const session = (key: string, fail = false): SessionHandle => ({
  key, id: key.split("/").at(-1)!, dir: home,
  record: (role, _text, extra) => Effect.suspend(() => {
    records.push({ key, role, extra })
    return fail ? Effect.die("mock persistence failure") : Effect.void
  }),
} as SessionHandle)
const fakeModel = (options: { minimal?: boolean; fail?: boolean } = {}) => {
  let calls = 0
  const client = HttpClient.make((req) => Effect.sync(() => {
    calls++
    if (options.fail) throw new Error("mock request failure")
    const events = [
      { type: "response.output_text.done", text: "answer" },
      { type: "response.completed", response: { usage: options.minimal ? { input_tokens: 3, output_tokens: 2 } : usage } },
    ]
    return HttpClientResponse.fromWeb(req, new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")))
  }))
  return { model: codexModel(client, "mock-codex"), calls: () => calls }
}
const rows = async (key: string) => (await readFile(codexRolloutIdentity(key).path, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
const tokens = async (key: string) => (await rows(key)).filter((r) => r.payload.type === "token_count")
beforeEach(async () => { records.length = 0; await rm(join(home, "sessions"), { recursive: true, force: true }) })
afterAll(async () => { await rm(home, { recursive: true, force: true }) })

test("every successful completion records durable usage and mirrors its returned ID", async () => {
  const { model, calls } = fakeModel()
  for (let i = 0; i < 2; i++) {
    const reply = await Effect.runPromise(model.complete(request).pipe(Effect.provideService(CurrentSession, session(root))))
    expect(reply.text).toBe("answer")
    expect(reply.usage).toEqual(counts)
  }
  expect(calls()).toBe(2)
  expect(records).toHaveLength(2)
  const mirrored = await tokens(root)
  expect(mirrored).toHaveLength(2)
  for (const [i, recorded] of records.entries()) {
    expect(recorded.role).toBe("usage")
    expect(recorded.extra.extra).toMatchObject({ system: "systemTwo", model: "mock-codex", provider: "codex", agent: root, ...counts })
    expect(mirrored[i].payload.usage_id).toBe(recorded.extra.extra.usageId)
    expect(typeof mirrored[i].payload.usage_id).toBe("string")
    expect(mirrored[i].payload.info.last_token_usage).toEqual({ input_tokens: 100, cached_input_tokens: 60, output_tokens: 25, reasoning_output_tokens: 10, total_tokens: 125 })
  }
  expect(mirrored[0].payload.usage_id).not.toBe(mirrored[1].payload.usage_id)
})

test("concurrent child and root completions use their own CurrentSession keys", async () => {
  const { model } = fakeModel()
  await Effect.runPromise(Effect.all([root, child].map((key) => model.complete(request).pipe(Effect.provideService(CurrentSession, session(key)))), { concurrency: "unbounded" }))
  for (const key of [root, child]) {
    const record = records.find((r) => r.key === key)!
    expect(record.extra.extra.agent).toBe(key)
    expect((await tokens(key))[0].payload.usage_id).toBe(record.extra.extra.usageId)
  }
})

test("main persistence failure still mirrors the allocated ID without retrying completion", async () => {
  const { model, calls } = fakeModel()
  const reply = await Effect.runPromise(model.complete(request).pipe(Effect.provideService(CurrentSession, session(child, true))))
  expect(reply.text).toBe("answer")
  expect(calls()).toBe(1)
  expect(records).toHaveLength(1)
  expect((await tokens(child))[0].payload.usage_id).toBe(records[0]!.extra.extra.usageId)
})

test("missing optional counts default to zero; no session writes nothing", async () => {
  const { model } = fakeModel({ minimal: true })
  await Effect.runPromise(model.complete(request))
  expect(records).toHaveLength(0)
  expect(await readFile(codexRolloutIdentity(root).path).catch(() => undefined)).toBeUndefined()
  await Effect.runPromise(model.complete(request).pipe(Effect.provideService(CurrentSession, session(root))))
  expect(records[0]!.extra.extra).toMatchObject({ input: 3, output: 2, cached: 0, thinking: 0 })
})

test("failed model completion does not record usage", async () => {
  const { model } = fakeModel({ fail: true })
  const exit = await Effect.runPromiseExit(model.complete(request).pipe(Effect.provideService(CurrentSession, session(root))))
  expect(exit._tag).toBe("Failure")
  expect(records).toHaveLength(0)
  expect(await readFile(codexRolloutIdentity(root).path).catch(() => undefined)).toBeUndefined()
})

test("rollout usage ID is optional and only attached to token_count payload", async () => {
  await Effect.runPromise(recordCodexUsage(root, "legacy", counts))
  await Effect.runPromise(recordCodexUsage(root, "identified", counts, "returned-id"))
  const all = await rows(root)
  const events = await tokens(root)
  expect(events[0].payload).not.toHaveProperty("usage_id")
  expect(events[1].payload.usage_id).toBe("returned-id")
  expect(all.filter((r) => r.type === "turn_context").every((r) => !("usage_id" in r.payload))).toBe(true)
})
