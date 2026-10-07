import { Effect, Layer, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { emit, recordUsage, retryIfTemporary, type StepState, SystemOne } from "empty-vessel"

// Jev's answers to our two questions: "next" (a choice) and "done" (yes/no). Only the fields we use are checked.
const JevResponse = Schema.Struct({
  answers: Schema.Struct({
    next: Schema.Struct({ choice: Schema.String, confidence: Schema.Number }),
    done: Schema.Struct({ noul: Schema.Number }),
  }),
  usage: Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number }),
})
// Jev's answers to one yes/no question per file, keyed f0, f1, …
const JevRelevant = Schema.Struct({
  answers: Schema.Record(Schema.String, Schema.Struct({ noul: Schema.Number })),
  usage: Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number }),
})

// Jev's answers to named choice questions (decide).
const JevChoices = Schema.Struct({
  answers: Schema.Record(Schema.String, Schema.Struct({ choice: Schema.String, confidence: Schema.Number })),
  usage: Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number }),
})

// Only decoded provider results are usage boundaries; persistence never changes returned tokens.
const recordJevUsage = ({ usage }: { readonly usage: { readonly input_tokens: number; readonly output_tokens: number } }) =>
  recordUsage({ system: "systemOne", model: "jev-latest", provider: "jev", tokens: { input: usage.input_tokens, output: usage.output_tokens } })

// Real System One: one Jev call per step, two questions answered in parallel (API: docs.typesafe.ai/api.md).
export const makeJevSystemOne = (apiKey: Redacted.Redacted<string>) =>
  Layer.effect(
    SystemOne,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
      const post = (body: object) =>
        HttpClientRequest.post("https://api.typesafe.ai/v1/systemone").pipe(
          HttpClientRequest.bearerToken(apiKey), // takes the Redacted key as-is: never revealed here
          HttpClientRequest.bodyJsonUnsafe({ model: "jev-latest", ...body }),
          client.execute,
          // Jev answers in ~0.1–0.5s; a request silent for 10s is stuck. A temporary failure gets one more try, then the
          // caller's fallback applies.
          Effect.timeout("10 seconds"),
          retryIfTemporary,
        )

      return SystemOne.of({
        judge: (state, questions) =>
          post({
            state,
            questions: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: "noul", instructions: q.question, criteria: { true: q.yes, false: q.no } }])),
          }).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(JevRelevant)),
            Effect.tap(recordJevUsage),
            Effect.map(({ answers, usage }) => ({ answers: Object.fromEntries(Object.keys(questions).map((k) => [k, answers[k]?.noul ?? 0])), tokens: { input: usage.input_tokens, output: usage.output_tokens } })),
            // A failed judgment means "no": nothing is flagged, nothing breaks.
            Effect.catch((e) => emit("error", 0, `jev failed, judging no: ${e}`).pipe(Effect.as({ answers: Object.fromEntries(Object.keys(questions).map((k) => [k, 0])), tokens: { input: 0, output: 0 } }))),
          ),
        // Nothing to score (an empty folder): no call, since Jev rejects a request with no questions (422).
        relevant: (goal, items) =>
          items.length === 0 ? Effect.succeed({ scores: [], tokens: { input: 0, output: 0 } }) : post({
            state: { goal, items },
            questions: Object.fromEntries(items.map((item, i) => [`f${i}`, {
              type: "noul",
              instructions: `Does the goal need this? ${item}`,
              criteria: { true: "The goal needs this file's contents, or something inside this folder", false: "This doesn't matter for the goal" },
            }])),
          }).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(JevRelevant)),
            Effect.tap(recordJevUsage),
            Effect.map(({ answers, usage }) => ({ scores: items.map((_, i) => answers[`f${i}`]?.noul ?? 0), tokens: { input: usage.input_tokens, output: usage.output_tokens } })),
            // Gathering is optional: if Jev fails, no files are picked and System Two reads what it needs itself.
            Effect.catch((e) => emit("error", 0, `jev failed, gathering nothing: ${e}`).pipe(Effect.as({ scores: items.map(() => 0), tokens: { input: 0, output: 0 } }))),
          ),
        decide: (state, questions) =>
          post({
            state,
            questions: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { type: "choice", instructions: q.question, criteria: q.options }])),
          }).pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(JevChoices)),
            Effect.tap(recordJevUsage),
            Effect.map(({ answers, usage }) => ({ answers, tokens: { input: usage.input_tokens, output: usage.output_tokens } })),
            // Jev failed: no answer stands (confidence 0), so each question goes to the caller's fallback.
            Effect.catch((e) => emit("error", 0, `jev failed, deciding nothing: ${e}`).pipe(Effect.as({ answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { choice: "", confidence: 0 }])), tokens: { input: 0, output: 0 } }))),
          ),
        choose: (state, options) =>
          HttpClientRequest.post("https://api.typesafe.ai/v1/systemone").pipe(
            HttpClientRequest.bearerToken(apiKey), // takes the Redacted key as-is: never revealed here
            HttpClientRequest.bodyJsonUnsafe({
              model: "jev-latest",
              state,
              questions: {
                next: {
                  type: "choice",
                  // The guard against loops: a step that failed or found nothing will do the same again with the same goal.
                  instructions: "What should the agent do next? If a step already failed or found nothing, " +
                    "choosing the same option again for the same goal gives the same result: choose a different option.",
                  criteria: options,
                },
                done: {
                  type: "noul",
                  instructions: "Is the goal already achieved by the steps taken so far?",
                  criteria: { true: "The steps' results complete the goal", false: "More work is needed, or nothing has been done yet" },
                },
              },
            }),
            client.execute,
            Effect.timeout("10 seconds"),
            retryIfTemporary,
            Effect.flatMap(HttpClientResponse.schemaBodyJson(JevResponse)),
            Effect.tap(recordJevUsage),
            Effect.map(({ answers, usage }) => ({
              ...answers.next,
              done: answers.done.noul,
              tokens: { input: usage.input_tokens, output: usage.output_tokens },
            })),
            // ponytail: any failure (network, 401, 429, bad reply) escalates to System Two; add backoff for 429/529 once real traffic shows them
            Effect.catch((e) => emit("error", 0, `jev failed, escalating: ${e}`).pipe(Effect.as({ choice: "escalate", confidence: 0, done: 0, tokens: { input: 0, output: 0 } }))),
          ),
      })
    }),
  )

// The core's fake System One's rules (src/system-one/systemone.ts), for the mock server: "!" → ask, a question →
// escalate, digits → countdown, anything else → echo. A copy: rules for a test double aren't part of the core's API.
const fakeChoice = (state: StepState) =>
  state.goal.startsWith("!") ? "ask" : state.goal.endsWith("?") ? "escalate" : /^\d+$/.test(state.goal) ? "countdown" : "echo"

// Pretends to be api.typesafe.ai: replies in Jev's exact format, deciding with the fake's rules.
// Lets the real Jev code above run end to end without a key.
export const MockJevHttp = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => {
      const body = new TextDecoder().decode((request.body as { body: Uint8Array }).body)
      const { state, questions } = JSON.parse(body)

      if (!questions.next) { // a relevance or judgment call: yes to every yes/no question, the first option of every choice
        const answer = (q: { type: string; criteria: Record<string, string> }) =>
          q.type === "choice" ? { type: "choice", choice: Object.keys(q.criteria)[0], confidence: 0.9 } : { type: "noul", noul: 0.9 }
        return HttpClientResponse.fromWeb(request, Response.json({ model: "jev-mock", answers: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, answer(q as never)])), usage: { input_tokens: Math.round(body.length / 4), output_tokens: 0 } }))
      }

      const choice = fakeChoice(state)
      const next = { type: "choice", choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 }
      const done = { type: "noul", noul: state.steps.length > 0 ? 0.9 : 0.1 }
      // usage is a rough guess: ~4 characters per token
      return HttpClientResponse.fromWeb(request, Response.json({ model: "jev-mock", answers: { next, done }, usage: { input_tokens: Math.round(body.length / 4), output_tokens: 0 } }))
    }),
  ),
)
