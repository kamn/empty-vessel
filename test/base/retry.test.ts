import { expect, test } from "bun:test"
import { Effect } from "effect"
import { isTemporary, retryIfTemporary } from "../../src/base/retry"

const status = (n: number) => ({ _tag: "HttpClientError", reason: { _tag: "StatusCodeError", response: { status: n } } })

test("isTemporary: timeouts, dropped connections, 5xx and 429 are worth one more try; the rest aren't", () => {
  expect([status(503), status(500), status(429), { _tag: "TimeoutError" }, { _tag: "HttpClientError", reason: { _tag: "TransportError" } }].map(isTemporary)).toEqual([true, true, true, true, true])
  expect([status(401), status(400), { _tag: "CodexReplyError" }, { _tag: "HttpClientError", reason: { _tag: "DecodeError" } }].map(isTemporary)).toEqual([false, false, false, false])
})

test("retryIfTemporary: one more try for a temporary failure, none for a permanent one", async () => {
  let tries = 0
  const failing = (e: unknown) => Effect.suspend(() => { tries++; return Effect.fail(e) })
  await Effect.runPromise(Effect.flip(retryIfTemporary(failing(status(503)))))
  expect(tries).toBe(2)
  tries = 0
  await Effect.runPromise(Effect.flip(retryIfTemporary(failing(status(401)))))
  expect(tries).toBe(1)
})
