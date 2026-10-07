import { mock, spyOn } from "bun:test"
import assert from "node:assert/strict"
import { Effect, Schema } from "effect"
import * as core from "../../../src/core"
import { recordUsage as durableRecordUsage } from "../../../src/base/usage"
import { CurrentSession, type SessionHandle } from "../../../src/base/session"

// Run in a subprocess: Bun module mocks must not leak into other plugin tests.
type Record = {
  system: string; model: string; provider: string; granularity: string
  usageId?: string; tokens: { input: number; output: number; cached?: number }
}
const records: Record[] = []
const durable: any[] = []
const session: SessionHandle = {
  id: "child", key: "sessions/root/child", dir: "/unused",
  record: (role, text, extra) => Effect.sync(() => {
    if (persistenceUnavailable) throw new Error("mock disk failure")
    durable.push({ role, text, ...extra })
  }),
}
let persistenceUnavailable = false
let ended: { answer: string; done: boolean } | undefined
const persistUsage = durableRecordUsage
mock.module("empty-vessel", () => ({
  ...core,
  recordUsage: (record: Record) => Effect.gen(function* () {
    records.push(record)
    return yield* persistUsage(record as Parameters<typeof durableRecordUsage>[0]).pipe(Effect.provideService(CurrentSession, session))
  }),
  serveTools: () => Effect.succeed({
    server: "test", mcpConfig: {}, busy: () => false, ended: () => ended,
  }),
}))
const { makeClaudeSystemTwo, makeClaudeAsk, makeClaudeFill, claudeLive } = await import("../../../src/plugins/claude/claude")
const { Ask, Fill, SystemTwo } = core
const usage = { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 7, cache_read_input_tokens: 3 }
const tokens = { input: 20, output: 4, cached: 3 }
const result = (extra = {}) => ({ type: "result", result: "answer", session_id: "shared-session", usage, ...extra })
let replies: unknown[] = []
let calls: string[][] = []
const spawn = spyOn(Bun, "spawn").mockImplementation(((argv: string[], options: any) => {
  assert.equal(argv[0], "mock-claude-only")
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined)
  calls.push(argv)
  assert.ok(replies.length, "unexpected CLI invocation")
  const reply = replies.shift()
  const text = typeof reply === "string" ? reply : JSON.stringify(reply)
  const streamed = argv.includes("stream-json")
  // Include assistant events and split chunks: only result usage counts.
  const output = streamed
    ? JSON.stringify({ type: "assistant", message: { usage, content: [{ type: "text", text: "answer" }] } }) + "\n" + text + "\n"
    : text
  return {
    stdin: { write() {}, end() {} },
    stdout: new ReadableStream({ start(controller) {
      const bytes = new TextEncoder().encode(output)
      controller.enqueue(bytes.slice(0, 17)); controller.enqueue(bytes.slice(17)); controller.close()
    } }),
    stderr: new Response("").body,
    exited: Promise.resolve(0), kill() {},
  }
}) as any)
process.env.EMPTY_VESSEL_CLAUDE_BIN = "mock-claude-only"
process.env.ANTHROPIC_API_KEY = "test-key-must-be-removed"
const reset = (...next: unknown[]) => { records.length = 0; durable.length = 0; calls = []; replies = next; ended = undefined; persistenceUnavailable = false }
const check = (count: number, model = "chosen") => {
  assert.equal(records.length, count)
  assert.equal(durable.length, persistenceUnavailable ? 0 : count)
  assert.equal(new Set(durable.map((row) => row.extra.usageId)).size, durable.length)
  for (const row of durable) {
    assert.equal(row.role, "usage")
    assert.equal(row.text, "model request")
    assert.equal(row.extra.agent, session.key)
    assert.equal(row.extra.granularity, "provider-result")
  }
  assert.equal(replies.length, 0)
  for (const record of records) {
    assert.equal(record.system, "systemTwo")
    assert.equal(record.provider, "claude")
    assert.equal(record.granularity, "provider-result")
    assert.equal(record.model, model)
    assert.equal(record.usageId, undefined, "session id must not deduplicate distinct calls")
  }
}
const main = (hooks = {}, model: string | undefined = "chosen") => Effect.runPromise(
  Effect.flatMap(SystemTwo, (service) => service.ask("hello", hooks)).pipe(Effect.provide(makeClaudeSystemTwo(model))),
)
const schema = Schema.Struct({ answer: Schema.String })
const structured = (kind: "ask" | "fill", model: string | undefined = "chosen") => kind === "ask"
  ? Effect.runPromise(Effect.flatMap(Ask, (service) => service.ask("instructions", schema, "question")).pipe(Effect.provide(makeClaudeAsk(model, "low"))))
  : Effect.runPromise(Effect.flatMap(Fill, (service) => service.fill("tool", schema, "goal")).pipe(Effect.provide(makeClaudeFill(model!))))

try {
  switch (process.argv[2]) {
    case "main": {
      reset(result())
      const reply = await main()
      assert.equal(reply.text, "answer")
      assert.deepEqual(reply.tokens, tokens)
      check(1)
      assert.deepEqual(records[0]!.tokens, tokens)
      reset(result(), result())
      let pending = 0
      const continued = await main({ pending: () => pending++ === 0 ? ["job"] : [] })
      assert.deepEqual(continued.tokens, { input: 40, output: 8, cached: 6 })
      check(2)
      reset(result())
      ended = { answer: "tool answer", done: true }
      const finished = await main()
      assert.equal(finished.text, "tool answer")
      assert.equal(finished.done, true)
      check(1)
      break
    }
    case "wrapup": {
      reset(result({ subtype: "error_max_turns" }), result({ usage: { input_tokens: 2, output_tokens: 1 } }))
      const reply = await main()
      check(2)
      assert.deepEqual(records.map((r) => r.tokens), [tokens, { input: 2, output: 1, cached: 0 }])
      assert.deepEqual(reply.tokens, { input: 22, output: 5, cached: 3 })
      assert.ok(calls[1]!.includes("--resume"))
      reset(result({ subtype: "error_max_turns" }), result({ usage: undefined }))
      const noWrapUsage = await main()
      check(1)
      assert.deepEqual(noWrapUsage.tokens, tokens)
      reset(result({ subtype: "error_max_turns", usage: undefined }), result())
      await main()
      check(1)
      break
    }
    case "structured": {
      for (const kind of ["ask", "fill"] as const) {
        reset(result({ structured_output: { answer: "yes" } }))
        const reply = await structured(kind)
        assert.deepEqual(reply.tokens, tokens)
        assert.deepEqual("value" in reply ? reply.value : reply.args, { answer: "yes" })
        check(1)
        for (const extra of [{ is_error: true }, {}, { structured_output: { answer: 123 } }]) {
          reset(result(extra))
          await assert.rejects(structured(kind))
          check(1) // Paid usage survives provider errors and schema failures.
        }
        reset(result({ structured_output: { answer: "yes" } }))
        persistenceUnavailable = true
        await structured(kind)
        check(1)
      }
      break
    }
    case "absent": {
      for (const absent of [undefined, null, {}, { unrelated: 42 }]) {
        reset(result({ usage: absent }))
        const reply = await main()
        assert.deepEqual(reply.tokens, { input: 0, output: 0, cached: 0 })
        check(0)
        for (const kind of ["ask", "fill"] as const) {
          reset(result({ usage: absent, structured_output: { answer: "yes" } }))
          await structured(kind)
          check(0)
        }
      }
      for (const partial of [{ input_tokens: 4 }, { output_tokens: 2 }, { input_tokens: -1, output_tokens: 2 }, { input_tokens: 3, output_tokens: "unknown" }]) {
        reset(result({ usage: partial }))
        await main()
        check(0)
      }
      reset("not json")
      await assert.rejects(structured("ask"))
      check(0)
      reset("not json")
      const failed = await main()
      assert.match(failed.text, /System Two failed/)
      check(0)
      reset(result({ usage: { input_tokens: 0, output_tokens: 0 } }))
      await main()
      check(1)
      assert.deepEqual(records[0]!.tokens, { input: 0, output: 0, cached: 0 })
      reset(result({ is_error: true }))
      assert.match((await main()).text, /System Two failed/)
      check(1)
      break
    }
    case "models": {
      reset(result({ structured_output: { answer: "yes" } }))
      await Effect.runPromise(Effect.flatMap(Ask, (service) => service.ask("instructions", schema, "--model")).pipe(
        Effect.provide(makeClaudeAsk(undefined, "low")),
      ))
      check(1, "claude-code-default") // Prompt text is not a model flag.
      assert.equal(calls[0]!.filter((arg) => arg === "--model").length, 1)
      reset(result())
      await Effect.runPromise(Effect.flatMap(SystemTwo, (service) => service.ask("hello")).pipe(Effect.provide(makeClaudeSystemTwo())))
      check(1, "claude-code-default")
      assert.ok(!calls[0]!.includes("--model"))
      reset(result({ model: "reported-model" }))
      await main()
      check(1, "reported-model")
      reset(result())
      const reply = await Effect.runPromise(claudeLive([], {}, { say() {}, busy: () => false, idle: "2 seconds" }, [{ type: "text", text: "hello" }]))
      assert.equal(reply.result, "answer")
      check(1, "claude-code-default")
      reset(result())
      persistenceUnavailable = true
      assert.equal((await main()).text, "answer")
      check(1)
      break
    }
    default: throw new Error("unknown scenario")
  }
  console.log(`PASS ${process.argv[2]}`)
} finally {
  spawn.mockRestore()
  mock.restore()
}
