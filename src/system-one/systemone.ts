import { Context, Effect, Layer } from "effect"
import type { Tokens } from "../base/usage"

// What System One sees at each step: the recent conversation (so "that" and "it" make sense),
// the goal, and the most recent steps taken so far.
export interface StepState {
  readonly did?: readonly string[] // what System One itself did in earlier turns, one line each (the last 20)
  readonly earlier?: readonly string[]
  readonly goal: string
  readonly steps: readonly string[]
}

type Question = { readonly question: string; readonly yes: string; readonly no: string }
export type Choice = { readonly question: string; readonly options: Readonly<Record<string, string>> }


// System One: fast, cheap judgment. Given the current state and a closed set of options
// (name → description of when to pick it), pick one and say how sure it is (0.0–1.0).
// Same shape as a System One "choice" question, where the descriptions are called "criteria".
export class SystemOne extends Context.Service<
  SystemOne,
  {
    readonly choose: (
      state: StepState,
      options: Readonly<Record<string, string>>,
    ) => Effect.Effect<{
      choice: string
      confidence: number
      done: number // 0–1: "is the goal already achieved?"
      tokens: Tokens // what this call sent and got back (0 for the fake)
    }>
    // For each item (a file or a folder, described in words), how likely (0–1) the goal needs it. One yes/no question each, all in one call.
    // Named yes/no questions about any state, all in one call: each answer is how likely (0–1) "yes" is.
    readonly judge: (state: object, questions: Readonly<Record<string, Question>>) => Effect.Effect<{ answers: Readonly<Record<string, number>>; tokens: Tokens }>
    readonly relevant: (goal: string, items: ReadonlyArray<string>) => Effect.Effect<{ scores: ReadonlyArray<number>; tokens: Tokens }>
    // Several named questions about the same state, one call: each picks one of its options, with a confidence.
    readonly decide: (state: object, questions: Readonly<Record<string, Choice>>) => Effect.Effect<{ answers: Readonly<Record<string, { choice: string; confidence: number }>>; tokens: Tokens }>
  }
>()("empty-vessel/SystemOne") {}

// Fake System One's rules (also used by the mock Jev server, src/plugins/jev/jev.ts):
// - starts with "!" → "ask": test hook for asking the user questions
// - a question (ends with "?") → "escalate": needs real thinking
// - otherwise, today's regex: digits → "countdown", anything else → "echo"
export const fakeChoice = (state: StepState) =>
  state.goal.startsWith("!") ? "ask"
    : state.goal.endsWith("?") ? "escalate"
    : /^\d+$/.test(state.goal) ? "countdown" : "echo"

// Fake System One: the rules above, always fully confident; done as soon as anything happened.
// System One (or Laya) is another Layer with the same shape; `turn` won't change.
export const FakeSystemOne = Layer.succeed(SystemOne, {
  choose: (state) => Effect.succeed({ choice: fakeChoice(state), confidence: 1, done: state.steps.length > 0 ? 1 : 0, tokens: { input: 0, output: 0 } }),
  judge: (_state, questions) => Effect.succeed({ answers: Object.fromEntries(Object.keys(questions).map((k) => [k, 0])), tokens: { input: 0, output: 0 } }),
  relevant: (_goal, items) => Effect.succeed({ scores: items.map(() => 1), tokens: { input: 0, output: 0 } }), // every file: the budget decides
  decide: (_state, questions) => Effect.succeed({ answers: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { choice: Object.keys(q.options)[0] ?? "", confidence: 1 }])), tokens: { input: 0, output: 0 } }), // the first option
})
