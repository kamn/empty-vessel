import { Effect, Schema } from "effect"
import { AskUser } from "../ui/ask"
import { Fill } from "../system-two/fill"
import type { Tokens } from "../base/usage"
import { type Step, timed } from "./turnkit"

// The early toy options, for testing the loop and sub-agents. Only offered with "testOptions": true in
// ~/.empty-vessel/config.json (in real use echo once replaced a correct answer).
export const TEST_OPTIONS = {
  countdown: "The goal is a whole number to count down from",
  echo: "Repeat the goal back to the user",
  // "ask" isn't offered even here (the stand-in looped: local-eval/cases/2026-09-26-ask-loop.md);
  // the fake System One can still pick it with the "!" test hook.
}

// countdown's input, filled in by the small LLM when the goal isn't plain digits. `cannot` is the honest way out:
// without it, strict JSON would force some number even for "count down from minus three" (it answered 3).
const CountdownArgs = Schema.Struct({
  n: Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))).annotate({ description: "The whole number to count down from, or null if there isn't one" }),
  cannot: Schema.NullOr(Schema.String).annotate({ description: "Why the request has no whole number ≥ 0 to count down from, or null if it does" }),
})
type Filled = { args: typeof CountdownArgs.Type; tokens: Tokens }

// Count down by spawning a sub-agent for n - 1: the test of sub-agents and their sessions.
const countdown: Step = (ctx, state) =>
  Effect.gen(function* () {
    state.did.push("countdown")
    // Digits need no LLM; anything else ("five") gets its number filled in by the small model.
    const { result: { args } } = yield* timed(ctx, "fill",
      /^\d+$/.test(ctx.input)
        ? Effect.succeed<Filled>({ args: { n: Number(ctx.input), cannot: null }, tokens: { input: 0, output: 0 } })
        : (yield* Fill).fill("countdown", CountdownArgs, ctx.input).pipe(
            Effect.catchTag("FillError", (e) => Effect.succeed({ args: { n: null, cannot: e.message }, tokens: { input: 0, output: 0 } })),
          ))
    const n = args.n
    if (n === null) return { reply: `can't count down: ${args.cannot ?? "no whole number in the goal"}`, outcome: "failed", answer: true }
    if (n === 0) return { reply: "liftoff", outcome: "ok", answer: true }
    if (ctx.depth >= ctx.config.maxDepth) return { reply: `${n} (depth limit, not spawning)`, outcome: "ok", answer: true }
    return { reply: `${n} → ${yield* ctx.spawn(String(n - 1)).pipe(Effect.catchTag("AgentError", Effect.die))}`, outcome: "ok", answer: true }
  })

const echo: Step = (ctx, state) =>
  Effect.sync(() => { state.did.push("echo"); return { reply: `echo: ${ctx.input}`, outcome: "ok", answer: true } })

// Stand-in: the LLM will write real questions. For now, ask about the message itself.
const ask: Step = (ctx, state) =>
  Effect.gen(function* () {
    state.did.push("ask")
    const answers = yield* (yield* AskUser).ask([{ question: ctx.input.slice(1).trim() || "Pick one", options: ["Yes", "No", "Not sure"] }])
    return { reply: answers.map((a) => `${a.answer}${a.note ? ` (note: ${a.note})` : ""}`).join("; "), outcome: "ok", answer: true }
  })

export const TEST_STEPS: Readonly<Record<string, Step>> = { countdown, echo, ask }
