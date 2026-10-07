import { randomUUIDv7 } from "bun"
import { Context, Effect, Layer, Ref } from "effect"
import { CurrentSession } from "./session"

// What one model call sent and got back.
export interface Tokens {
  readonly input: number
  readonly output: number
  readonly cached?: number // how many of the input tokens the provider served from its prompt cache
  readonly thinking?: number // how many of the output tokens were hidden reasoning ("thinking") before the answer
}

// Durable provider usage is independent of the runtime tallies below. Invoke only after
// parsing real provider usage, never from counters or invented fallback tokens.
export const recordUsage = (request: {
  readonly system: "systemOne" | "systemTwo"
  readonly model: string
  readonly tokens: Tokens
  readonly provider?: string
  readonly usageId?: string
  readonly granularity?: "provider-result"
}): Effect.Effect<string | undefined> => Effect.gen(function* () {
  const session = yield* CurrentSession
  if (!session) return undefined
  const usageId = request.usageId ?? randomUUIDv7()
  const { input, output, cached, thinking } = request.tokens
  const extra = {
    usageVersion: 1, usageId, system: request.system, model: request.model, agent: session.key,
    input, output,
    ...(cached === undefined ? {} : { cached }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(request.provider === undefined ? {} : { provider: request.provider }),
    ...(request.granularity === undefined ? {} : { granularity: request.granularity }),
  }
  // Keep the allocated ID even when writing fails: provider mirrors use it for fallback
  // and deduplication. A broken writer (or logger) must never retry a successful call.
  yield* Effect.suspend(() => session.record("usage", "model request", { extra })).pipe(
    Effect.catchCause(() => Effect.logWarning("Usage persistence failed; agent continues").pipe(
      Effect.catchCause(() => Effect.void),
    )),
  )
  return usageId
})

type Tally = { readonly ms: number; readonly input: number; readonly cached: number; readonly output: number; readonly thinking: number }
// turn: wall-clock time of whole turns (tokens stay 0); systemOne and systemTwo: time and tokens of their calls.
export type Totals = { readonly turn: Tally; readonly systemOne: Tally; readonly systemTwo: Tally; readonly fill: Tally }

const zero: Tally = { ms: 0, input: 0, cached: 0, output: 0, thinking: 0 }
const empty = (): Totals => ({ turn: zero, systemOne: zero, systemTwo: zero, fill: zero })
const plus = (t: Totals, who: keyof Totals, ms: number, tokens: Tokens): Totals => ({
  ...t,
  [who]: { ms: t[who].ms + ms, input: t[who].input + tokens.input, cached: t[who].cached + (tokens.cached ?? 0), output: t[who].output + tokens.output, thinking: t[who].thinking + (tokens.thinking ?? 0) },
})

// Time and tokens spent per system, shared by the root agent and every sub-agent.
export class Usage extends Context.Service<
  Usage,
  {
    readonly add: (who: keyof Totals, ms: number, tokens: Tokens) => Effect.Effect<void>
    // This turn's totals (then reset to zero for the next turn) and the whole session's (never reset).
    readonly take: Effect.Effect<{ turn: Totals; session: Totals }>
  }
>()("empty-vessel/Usage") {
  static readonly layer = Layer.effect(
    Usage,
    Effect.gen(function* () {
      const turn = yield* Ref.make(empty())
      const session = yield* Ref.make(empty())
      return Usage.of({
        add: (who, ms, tokens) =>
          Effect.andThen(Ref.update(turn, (t) => plus(t, who, ms, tokens)), Ref.update(session, (t) => plus(t, who, ms, tokens))),
        take: Effect.all({ turn: Ref.getAndSet(turn, empty()), session: Ref.get(session) }),
      })
    }),
  )
}
