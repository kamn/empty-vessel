import { Context, Effect, Layer, Schema } from "effect"

// A question for the user: 1–3 suggested options. The user can always type their own answer instead.
// A Schema, because questions will come from the LLM, and its output must be checked.
export const Question = Schema.Struct({
  question: Schema.NonEmptyString,
  options: Schema.Array(Schema.NonEmptyString).pipe(Schema.check(Schema.isLengthBetween(1, 3))),
})
type Question = typeof Question.Type

interface Answer {
  readonly question: string
  readonly answer: string // one of the options, or the user's own words
  readonly note?: string // optional extra context from the user
}

// Asks the user one or more questions, all in one go.
export class AskUser extends Context.Service<
  AskUser,
  { readonly ask: (questions: ReadonlyArray<Question>) => Effect.Effect<ReadonlyArray<Answer>> }
>()("empty-vessel/AskUser") {}

// Terminal version: numbered options; anything that isn't an option number is a free-form answer.
export const TerminalAskUser = Layer.succeed(AskUser, {
  ask: (questions) =>
    Effect.sync(() =>
      questions.map(({ question, options }) => {
        console.log(`\n${question}`)
        options.forEach((option, i) => console.log(`  ${i + 1}. ${option}`))
        const raw = prompt(`Pick 1-${options.length}, or type your own answer:`) ?? ""
        const note = prompt("Note (optional, Enter to skip):") || undefined
        return { question, answer: options[Number(raw) - 1] ?? raw, note }
      }),
    ),
})
