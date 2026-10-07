import { Effect, Layer, Schema } from "effect"
import { jsonSchemaFor } from "../base/json-schema"
import { Ask, AskError } from "./ask"
import { Fill, FillError } from "./fill"
import { type Model, systemTwoFromModel, userItem } from "./loop"

// Fill and Ask from a model, so a model plugin needn't write its own: one
// request, no tools, its reply forced into the schema's JSON form (strict: every field required, so these schemas have
// no optional ones), then checked against the schema on the way back in, since it comes from outside.
const answer = <S extends Schema.Top>(model: Model, instructions: string, input: string, name: string, schema: S) =>
  Effect.gen(function* () {
    const reply = yield* model.complete({ instructions, thread: [userItem(input)], tools: [], schema: { name, schema: jsonSchemaFor(schema) } }).pipe(Effect.mapError((e) => `${model.name}: ${String(e)}`))
    const parsed = yield* Effect.try({ try: () => JSON.parse(reply.text), catch: () => `${model.name}'s answer isn't JSON: ${reply.text.slice(0, 200)}` })
    const value = yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(Effect.mapError((e) => `${model.name}'s answer doesn't fit: ${e.message}`))
    return { value, tokens: reply.usage }
  })

// Fill: a tool's arguments from the goal, by a small model with no context.
export const fillFromModel = (model: Model) => Layer.succeed(Fill, {
  fill: (name, schema, goal) =>
    answer(model, `Fill in the arguments for the "${name}" tool from the user's request.`, goal, name, schema).pipe(
      Effect.map(({ value, tokens }) => ({ args: value, tokens })),
      Effect.mapError((message) => new FillError({ message })),
    ),
})

// Ask: one question to the main model (the reviewer, adoption), with its reasoning.
export const askFromModel = (model: Model) => Layer.succeed(Ask, {
  ask: (instructions, schema, input) =>
    answer(model, instructions, input, "answer", schema).pipe(
      Effect.map(({ value, tokens }) => ({ value, tokens: { input: tokens.input, output: tokens.output, cached: tokens.cached } })),
      Effect.mapError((message) => new AskError({ message })),
    ),
})

// Everything a model plugin provides, from its models: System Two (the main model, the core's loop around it), Ask
// (the main model again) and Fill (a smaller one, or the main one).
export const modelParts = (main: Model, small: Model, maxRounds: number) =>
  ({ systemTwo: systemTwoFromModel(main, maxRounds), ask: askFromModel(main), fill: fillFromModel(small) })
