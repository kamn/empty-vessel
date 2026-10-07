import { Effect, Schedule } from "effect"

// Worth one more try: a timeout or a stalled stream, the network dropping, the server overloaded (5xx) or rate limiting us (429).
// Not worth it: anything the next try would hit the same way (401 logged out, 400 a bad request, a reply we can't read).
export const isTemporary = (e: unknown) => {
  const err = e as { _tag?: string; reason?: { _tag?: string; response?: { status?: number } } }
  if (err._tag === "TimeoutError" || err._tag === "CodexStallError") return true // a stuck stream (System Two's idle limit)
  if (err._tag !== "HttpClientError") return false
  if (err.reason?._tag === "TransportError") return true
  const status = err.reason?._tag === "StatusCodeError" ? (err.reason.response?.status ?? 0) : 0
  return status >= 500 || status === 429
}

// Try once more after a short pause if the failure was temporary.
export const retryIfTemporary = <A, E, R>(call: Effect.Effect<A, E, R>) =>
  call.pipe(Effect.retry({ times: 1, schedule: Schedule.spaced("2 seconds"), while: isTemporary }))
