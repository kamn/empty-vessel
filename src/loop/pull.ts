import { Effect } from "effect"
import { MemoryPull, type PullCandidate, type PullUsage } from "../base/memory"
import { type Ctx, timed } from "./turnkit"

// The turn-start pull (KTD12): once per turn, before System One's first decision, the active memory's candidate facts
// for the goal, scored by System One in one call (as gather scores files: src/system-one/explore.ts); the ones it keeps
// go into its own view and System Two's first prompt for the whole turn, never the briefing (cached once per conversation).
const MAX_CANDIDATES = 40 // shown to System One in its one call
const KEEP_AT = 0.6 // as gather's PICK_AT
const MAX_FACTS = 12
const MAX_CHARS = 2000
const NEVER = new Set(["existence", "observation"]) // what a fact's kind says isn't worth a turn's attention

export type Pulled = { readonly shown: ReadonlyArray<string>; readonly picked: ReadonlyArray<PullCandidate> }

// No memory offering candidates, or none, or System One failing: undefined, and the turn goes on as it would have.
// `limits`: to try other budgets; the defaults are the constants above.
export const pull = (ctx: Ctx, goal: string, limits: { readonly facts?: number; readonly chars?: number } = {}) =>
  Effect.gen(function* () {
    const { candidates } = yield* MemoryPull
    if (!candidates) return undefined
    const shown = (yield* candidates(goal)).filter((c) => !NEVER.has(c.kind ?? "")).slice(0, MAX_CANDIDATES)
    if (!shown.length) return undefined

    const { result: { scores } } = yield* timed(ctx, "systemOne", ctx.systemOne.relevant(goal, shown.map((c) => `fact: ${c.text}`)))

    // The best first, while they fit: a fact too long for what's left is skipped, a shorter one after it may still fit.
    const maxFacts = limits.facts ?? MAX_FACTS, maxChars = limits.chars ?? MAX_CHARS
    const picked: Array<PullCandidate> = []
    let chars = 0
    const ranked = shown.map((c, i) => ({ c, score: scores[i] ?? 0 })).filter((s) => s.score >= KEEP_AT).sort((a, b) => b.score - a.score)
    for (const { c } of ranked) {
      if (picked.length >= maxFacts) break
      if (chars + c.text.length > maxChars) continue
      picked.push(c)
      chars += c.text.length
    }

    yield* Effect.logDebug(`pull ${JSON.stringify({ shown: shown.length, picked: picked.map((c) => c.id), scores })}`)
    return { shown: shown.map((c) => c.id), picked } satisfies Pulled
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))

// At the turn's end (KTD18): what the pull showed and picked, and how the turn went, to the memory that offered them.
// Reporting is the memory's business: a failure here never fails the turn.
export const reportPull = (pulled: Pulled | undefined, outcome: PullUsage["outcome"]) =>
  Effect.gen(function* () {
    const { reportUsage } = yield* MemoryPull
    if (pulled && reportUsage) yield* reportUsage({ shown: pulled.shown, picked: pulled.picked.map((c) => c.id), outcome })
  }).pipe(Effect.catchCause(() => Effect.void))
