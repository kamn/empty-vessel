import { expect, test } from "bun:test"
import { Effect } from "effect"
import { isTemporary, retryDelay, retryIfTemporary } from "../../src/base/retry"

const status = (n: number, headers: Record<string, string> = {}) => ({ _tag: "HttpClientError", reason: { _tag: "StatusCodeError", response: { status: n, headers } } })

test("isTemporary: timeouts, dropped connections, 5xx and 429 are worth another try; the rest aren't", () => {
  expect([status(503), status(500), status(429), { _tag: "TimeoutError" }, { _tag: "HttpClientError", reason: { _tag: "TransportError" } }].map(isTemporary)).toEqual([true, true, true, true, true])
  expect([status(401), status(400), { _tag: "CodexReplyError" }, { _tag: "HttpClientError", reason: { _tag: "DecodeError" } }].map(isTemporary)).toEqual([false, false, false, false])
})

test("retryDelay: 2, 4, 8 s then give up; Retry-After (seconds or a date) wins, capped at 30 s; a timeout gets one retry", () => {
  expect([1, 2, 3, 4].map((n) => retryDelay(status(503), n))).toEqual([2000, 4000, 8000, undefined])
  expect(retryDelay(status(429, { "retry-after": "5" }), 1)).toBe(5000)
  expect(retryDelay(status(429, { "retry-after": "600" }), 1)).toBe(30_000)
  expect(retryDelay(status(429, { "retry-after": new Date(10_000).toUTCString() }), 1, 4, 30_000, 7000)).toBe(3000)
  expect(retryDelay(status(429, { "retry-after": "soon" }), 2)).toBe(4000)
  expect([1, 2].map((n) => retryDelay({ _tag: "TimeoutError" }, n))).toEqual([2000, undefined])
  expect([1, 2].map((n) => retryDelay(status(503), n, 2))).toEqual([2000, undefined]) // fewer tries for a caller with a fallback
  expect(retryDelay(status(429, { "retry-after": "20" }), 1, 2, 2000)).toBe(2000) // and shorter waits
})

test("retryIfTemporary: retries a temporary failure until it gives up, a permanent one never; a later success comes through", async () => {
  let tries = 0
  const failing = (e: unknown) => Effect.suspend(() => { tries++; return Effect.fail(e) })
  await Effect.runPromise(Effect.flip(retryIfTemporary(failing(status(503, { "retry-after": "0" })))))
  expect(tries).toBe(4)

  tries = 0
  await Effect.runPromise(Effect.flip(retryIfTemporary(failing(status(401)))))
  expect(tries).toBe(1)

  tries = 0
  const flaky = Effect.suspend(() => (++tries < 3 ? Effect.fail(status(429, { "retry-after": "0" })) : Effect.succeed("ok")))
  expect(await Effect.runPromise(retryIfTemporary(flaky))).toBe("ok")
})
