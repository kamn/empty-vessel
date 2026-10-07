import { expect, test } from "bun:test"
import { Effect, Layer, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { CurrentSession, SessionError, type SessionHandle } from "../../src/base/session"
import { Events } from "../../src/base/events"
import { Usage } from "../../src/base/usage"
import { SystemOne } from "../../src/system-one/systemone"
import { makeJevSystemOne } from "../../src/plugins/jev/jev"

const tokens = { input: 37, output: 9 }
const zero = { input: 0, output: 0 }
const cases = [
  {
    name: "choose",
    call: (s: SystemOne["Service"]) => s.choose({ goal: "test", steps: [] }, { echo: "Echo" }),
    answers: { next: { choice: "echo", confidence: 0.8 }, done: { noul: 0.2 } },
    result: { choice: "echo", confidence: 0.8, done: 0.2, tokens },
    fallback: { choice: "escalate", confidence: 0, done: 0, tokens: zero },
  },
  {
    name: "judge",
    call: (s: SystemOne["Service"]) => s.judge({}, { a: { question: "A?", yes: "Yes", no: "No" }, b: { question: "B?", yes: "Yes", no: "No" } }),
    answers: { a: { noul: 0.8 } },
    result: { answers: { a: 0.8, b: 0 }, tokens },
    fallback: { answers: { a: 0, b: 0 }, tokens: zero },
  },
  {
    name: "relevant",
    call: (s: SystemOne["Service"]) => s.relevant("test", ["a.ts", "b.ts"]),
    answers: { f0: { noul: 0.8 } },
    result: { scores: [0.8, 0], tokens },
    fallback: { scores: [0, 0], tokens: zero },
  },
  {
    name: "decide",
    call: (s: SystemOne["Service"]) => s.decide({}, { a: { question: "A?", options: { yes: "Yes" } } }),
    answers: { a: { choice: "yes", confidence: 0.8 } },
    result: { answers: { a: { choice: "yes", confidence: 0.8 } }, tokens },
    fallback: { answers: { a: { choice: "", confidence: 0 } }, tokens: zero },
  },
] as const

type Reply = { status?: number; body?: unknown; raw?: string }
const run = async (call: (s: SystemOne["Service"]) => Effect.Effect<unknown>, replies: Reply[], writer: "ok" | "fail" | "die" | "throw" | "absent" = "ok") => {
  const requests: unknown[] = []
  const rows: { role: string; text: string; extra?: Readonly<Record<string, unknown>> }[] = []
  let writes = 0
  const session: SessionHandle = {
    id: "jev-test", key: "sessions/jev-test", dir: "/unused",
    record: (role, text, extra) => {
      writes++
      if (writer === "throw") throw new Error("writer threw")
      if (writer === "fail") return Effect.fail(new SessionError({ cause: "writer failed" }))
      if (writer === "die") return Effect.die("writer defect")
      return Effect.sync(() => { rows.push({ role, text, extra }) })
    },
  }
  const http = Layer.succeed(HttpClient.HttpClient, HttpClient.make((request) => Effect.sync(() => {
    expect(request.url).toBe("https://api.typesafe.ai/v1/systemone")
    const body = JSON.parse(new TextDecoder().decode((request.body as { body: Uint8Array }).body))
    expect(body.model).toBe("jev-latest")
    requests.push(body)
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!
    return HttpClientResponse.fromWeb(request, reply.raw === undefined
      ? Response.json(reply.body ?? {}, { status: reply.status ?? 200 })
      : new Response(reply.raw, { status: reply.status ?? 200 }))
  })))
  const result = await Effect.runPromise(Effect.gen(function* () {
    const tally = yield* Usage
    const before = yield* tally.take
    const value = yield* call(yield* SystemOne)
    const after = yield* tally.take
    expect(after).toEqual(before)
    return value
  }).pipe(
    Effect.provide(makeJevSystemOne(Redacted.make("test-key")).pipe(Layer.provide(http))),
    Effect.provide(Usage.layer),
    Effect.provideService(CurrentSession, writer === "absent" ? undefined : session),
    Effect.provideService(Events, { emit: () => Effect.void }),
  ))
  return { result, requests, rows, writes }
}
const success = (answers: unknown, input = 37, output = 9): Reply => ({ body: { answers, usage: { input_tokens: input, output_tokens: output } } })
const expectUsage = (rows: Awaited<ReturnType<typeof run>>["rows"], input = 37, output = 9) => {
  expect(rows).toHaveLength(1)
  expect(rows[0]!.role).toBe("usage")
  expect(rows[0]!.extra?.extra).toMatchObject({ system: "systemOne", model: "jev-latest", provider: "jev", input, output, agent: "sessions/jev-test" })
  expect((rows[0]!.extra?.extra as { usageId: string }).usageId).toBeString()
}

for (const c of cases) {
  test(`${c.name}: parsed success records once without changing answers or tallies`, async () => {
    const r = await run(c.call, [success(c.answers)])
    expect(r.result).toEqual(c.result)
    expect(r.requests).toHaveLength(1)
    expect(r.writes).toBe(1)
    expectUsage(r.rows)
  })
  test(`${c.name}: real zero-token usage is still recorded`, async () => {
    const r = await run(c.call, [success(c.answers, 0, 0)])
    expect(r.result).toEqual({ ...c.result, tokens: zero })
    expectUsage(r.rows, 0, 0)
  })
  for (const [name, reply] of Object.entries({
    unauthorized: { status: 401 },
    invalidJson: { raw: "not json" },
    invalidAnswers: { body: { answers: { a: "bad" }, usage: { input_tokens: 37, output_tokens: 9 } } },
    missingUsage: { body: { answers: c.answers } },
    invalidUsage: { body: { answers: c.answers, usage: { input_tokens: "37", output_tokens: 9 } } },
  })) {
    test(`${c.name}: ${name} falls back without invented usage`, async () => {
      const r = await run(c.call, [reply])
      expect(r.result).toEqual(c.fallback)
      expect(r.requests).toHaveLength(1)
      expect(r.writes).toBe(0)
      expect(r.rows).toEqual([])
    })
  }
  for (const writer of ["fail", "die", "throw", "absent"] as const) {
    test(`${c.name}: ${writer} writer cannot change success or retry the endpoint`, async () => {
      const r = await run(c.call, [success(c.answers)], writer)
      expect(r.result).toEqual(c.result)
      expect(r.requests).toHaveLength(1)
      expect(r.writes).toBe(writer === "absent" ? 0 : 1)
      expect(r.rows).toEqual([])
    })
  }
  test(`${c.name}: retry records only the successful boundary`, async () => {
    const r = await run(c.call, [{ status: 503 }, success(c.answers)])
    expect(r.result).toEqual(c.result)
    expect(r.requests).toHaveLength(2)
    expect(r.writes).toBe(1)
    expectUsage(r.rows)
  }, 10_000)
  test(`${c.name}: exhausted retry has no usage`, async () => {
    const r = await run(c.call, [{ status: 429 }])
    expect(r.result).toEqual(c.fallback)
    expect(r.requests).toHaveLength(2)
    expect(r.writes).toBe(0)
    expect(r.rows).toEqual([])
  }, 10_000)
}

test("empty relevance does not call Jev or record fallback zeros", async () => {
  const r = await run((s) => s.relevant("test", []), [])
  expect(r.result).toEqual({ scores: [], tokens: zero })
  expect(r.requests).toEqual([])
  expect(r.writes).toBe(0)
})

test("repeated successful calls have separate usage IDs", async () => {
  const r = await run((s) => Effect.all([cases[0].call(s), cases[0].call(s)]), [success(cases[0].answers)])
  expect(r.requests).toHaveLength(2)
  expect(r.rows).toHaveLength(2)
  const ids = r.rows.map((row) => (row.extra?.extra as { usageId: string }).usageId)
  expect(new Set(ids).size).toBe(2)
})
