import { Effect } from "effect"

type Failure = { _tag?: string; reason?: { _tag?: string; response?: { status?: number; headers?: Readonly<Record<string, string>> } } }

// Worth one more try: a timeout or a stalled stream, the network dropping, the server overloaded (5xx) or rate limiting us (429).
// Not worth it: anything the next try would hit the same way (401 logged out, 400 a bad request, a reply we can't read).
export const isTemporary = (e: unknown) => {
  const err = e as Failure
  if (isSlow(err)) return true // a stuck stream (System Two's idle limit)
  if (err._tag !== "HttpClientError") return false
  if (err.reason?._tag === "TransportError") return true
  const status = err.reason?._tag === "StatusCodeError" ? (err.reason.response?.status ?? 0) : 0
  return status >= 500 || status === 429
}
const isSlow = (err: Failure) => err._tag === "TimeoutError" || err._tag === "CodexStallError"

const MAX_WAIT_MS = 30_000

// How long to wait before try `n + 1` of `tries`: what the server asked for (Retry-After, in seconds or as a date), up
// to 30 s; else 2 s, 4 s, 8 s. A slow call (a timeout, a stall) gets one more try at most: it already took its whole limit.
// A rate limit or an overloaded server often clears within seconds.
export const retryDelay = (e: unknown, n: number, tries = 4, maxWaitMs = MAX_WAIT_MS, now = Date.now()) => {
  const err = e as Failure
  if (n >= (isSlow(err) ? Math.min(tries, 2) : tries)) return undefined

  const after = err.reason?.response?.headers?.["retry-after"]
  const asked = after === undefined ? NaN : /^\d+$/.test(after.trim()) ? Number(after) * 1000 : Date.parse(after) - now
  return Math.min(maxWaitMs, Number.isFinite(asked) ? Math.max(0, asked) : 2000 * 2 ** (n - 1))
}

// Try again after a pause while the failure is temporary, up to `tries` in all, waiting at most `maxWaitMs` (retryDelay
// says how long). A caller with a fallback (System One escalates) wants few and short; one without (System Two's reply)
// the defaults.
export const retryIfTemporary = <A, E, R>(call: Effect.Effect<A, E, R>, tries = 4, maxWaitMs = MAX_WAIT_MS): Effect.Effect<A, E, R> => {
  const attempt = (n: number): Effect.Effect<A, E, R> =>
    call.pipe(Effect.catch((e) => {
      const wait = isTemporary(e) ? retryDelay(e, n, tries, maxWaitMs) : undefined
      return wait === undefined ? Effect.fail(e) : Effect.sleep(wait).pipe(Effect.andThen(attempt(n + 1)))
    }))
  return attempt(1)
}
