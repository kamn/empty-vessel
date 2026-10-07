import { expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { CurrentSession, SessionMirror, makeSession, openSession, type SessionHandle } from "../../src/base/session"
import { diskStore } from "../../src/base/store"
import { codexModel, makeCodexSystemTwo } from "../../src/plugins/codex/codex"
import { type Model, systemTwoFromModel } from "../../src/system-two/loop"
import { SystemTwo } from "../../src/system-two/systemtwo"

// Fail before any request or write if someone runs this fixture outside its wrapper.
if (process.env.EMPTY_VESSEL_RECORDING_TEST !== "1" || process.env.CODEX_HOME !== join(homedir(), ".codex") || process.env.EMPTY_VESSEL_HOME !== join(homedir(), ".empty-vessel")) {
  throw new Error("Run test/plugins/codex-recording.test.ts with its isolated HOME")
}
globalThis.fetch = Object.assign(() => { throw new Error("Real HTTP is forbidden in recording tests") }, {
  preconnect: () => { throw new Error("Real HTTP is forbidden in recording tests") },
})
const files = (dir = join(process.env.CODEX_HOME!, "sessions")): string[] => !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name)
  return entry.isDirectory() ? files(path) : path.endsWith(".jsonl") ? [path] : []
})
const rows = (path: string): any[] => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line))
const usage = { input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 10 } }
const expected = { input_tokens: 100, cached_input_tokens: 60, output_tokens: 25, reasoning_output_tokens: 10, total_tokens: 125 }
const request = { instructions: "Answer briefly", thread: [], tools: [] }

const fakeHttp = () => {
  const requests: any[] = []
  const client = HttpClient.make((httpRequest) => Effect.sync(() => {
    requests.push(JSON.parse(new TextDecoder().decode((httpRequest.body as { body: Uint8Array }).body)))
    const events = [{ type: "response.output_text.done", text: "Recorded answer" }, { type: "response.completed", response: { usage } }]
    return HttpClientResponse.fromWeb(httpRequest, new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }))
  }))
  return { requests, client }
}
const recordedTurn = (session: SessionHandle, text: string) => Effect.gen(function* () {
  const two = yield* SystemTwo
  expect(two.sessionMirror).toBeDefined()
  return yield* Effect.gen(function* () {
    yield* session.record("user", text)
    const reply = yield* two.ask(text, { thread: [] })
    yield* session.record("assistant", reply.text)
    return reply
  }).pipe(Effect.provideService(CurrentSession, session), Effect.provideService(SessionMirror, two.sessionMirror!))
})
const tokenRows = (entries: any[]) => entries.filter((entry) => entry.type === "event_msg" && entry.payload.type === "token_count")
const sessionRows = (session: SessionHandle) => {
  const matches = files().filter((path) => rows(path)[0]?.payload.id === session.id)
  expect(matches).toHaveLength(1)
  return rows(matches[0]!)
}

test("Codex turns mirror messages and identical usage again after reopening a disk session", () => Effect.runPromise(Effect.gen(function* () {
  const { client, requests } = fakeHttp()
  const layer = makeCodexSystemTwo("recording-main", "low", 2).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))
  const session = yield* makeSession("sessions")
  yield* recordedTurn(session, "First question").pipe(Effect.provide(layer))
  const reopened = yield* openSession(session.key)
  yield* recordedTurn(reopened, "Second question").pipe(Effect.provide(layer))

  expect(requests).toHaveLength(2)
  expect(requests.map((r) => r.model)).toEqual(["recording-main", "recording-main"])
  const entries = sessionRows(reopened)
  expect(entries.filter((e) => e.type === "session_meta")).toHaveLength(1)
  expect(entries.filter((e) => e.type === "turn_context").map((e) => e.payload.model)).toEqual(["recording-main", "recording-main"])
  expect(tokenRows(entries).map((e) => e.payload.info.last_token_usage)).toEqual([expected, expected])
  expect(entries.filter((e) => e.payload.type === "user_message").map((e) => e.payload.message)).toEqual(["First question", "Second question"])
  expect(entries.filter((e) => e.payload.type === "agent_message").map((e) => e.payload.message)).toEqual(["Recorded answer", "Recorded answer"])
  expect(entries.filter((e) => e.payload.type === "task_complete")).toHaveLength(2)
  const disk = rows(join(reopened.dir, "main.jsonl"))
  expect(disk.map((e) => e.role)).toEqual(["project", "user", "assistant", "resumed", "user", "assistant"])
  expect(disk.filter((e) => e.role === "assistant").map((e) => e.text)).toEqual(["Recorded answer", "Recorded answer"])
}).pipe(Effect.provide(diskStore()))))

test("auxiliary Codex calls record with CurrentSession but leave disk untouched without it", () => Effect.runPromise(Effect.gen(function* () {
  const { client, requests } = fakeHttp()
  const model = codexModel(client, "recording-auxiliary")
  const before = files().map((path) => [path, readFileSync(path, "utf8")])
  yield* model.complete(request)
  expect(files().map((path) => [path, readFileSync(path, "utf8")])).toEqual(before)

  const session = yield* makeSession("sessions")
  const reply = yield* model.complete(request).pipe(Effect.provideService(CurrentSession, session))
  expect(reply.usage).toEqual({ input: 100, cached: 60, output: 25, thinking: 10 })
  expect(requests).toHaveLength(2)
  const entries = sessionRows(session)
  expect(entries.filter((e) => e.type === "session_meta")).toHaveLength(1)
  expect(entries.filter((e) => e.type === "turn_context").map((e) => e.payload.model)).toEqual(["recording-auxiliary"])
  expect(tokenRows(entries).map((e) => e.payload.info.last_token_usage)).toEqual([expected])
  expect(rows(join(session.dir, "main.jsonl")).map((e) => e.role)).toEqual(["project"])
}).pipe(Effect.provide(diskStore()))))

test("a non-Codex model with session context records no Codex usage or rollout", () => Effect.runPromise(Effect.gen(function* () {
  const before = files().map((path) => [path, readFileSync(path, "utf8")])
  const session = yield* makeSession("sessions")
  const model: Model = { name: "not-codex", complete: () => Effect.succeed({ text: "Other answer", calls: [], keep: [], thinking: "", searches: [], usage: { input: 100, cached: 60, output: 25, thinking: 10 } }) }
  yield* Effect.gen(function* () {
    const two = yield* SystemTwo
    expect(two.sessionMirror).toBeUndefined()
    yield* Effect.gen(function* () {
      yield* session.record("user", "Other question")
      const reply = yield* two.ask("Other question", { thread: [] })
      yield* session.record("assistant", reply.text)
    }).pipe(Effect.provideService(CurrentSession, session), Effect.provideService(SessionMirror, two.sessionMirror ?? (() => Effect.void)))
  }).pipe(Effect.provide(systemTwoFromModel(model, 2)))

  expect(files().map((path) => [path, readFileSync(path, "utf8")])).toEqual(before)
  expect(rows(join(session.dir, "main.jsonl")).map((e) => e.role)).toEqual(["project", "user", "assistant"])
}).pipe(Effect.provide(diskStore()))))
