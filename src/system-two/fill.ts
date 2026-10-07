import { Context, Data, Effect, Layer, Schema } from "effect"
import type { Tokens } from "../base/usage"

export class FillError extends Data.TaggedError("FillError")<{ message: string }> {}

// Fill in a tool's arguments from the goal: a small LLM with no context, its reply forced into the tool's
// input Schema (and checked against it on the way back in, since it comes from outside our code).
export class Fill extends Context.Service<
  Fill,
  {
    readonly fill: <S extends Schema.Top & { readonly DecodingServices: never }>(name: string, schema: S, goal: string) => Effect.Effect<{ args: S["Type"]; tokens: Tokens }, FillError>
  }
>()("empty-vessel/Fill") {}

// Fake: there's no LLM, so it can't fill anything in. Callers fall back (e.g. escalate to System Two).
export const FakeFill = Layer.succeed(Fill, {
  fill: () => Effect.fail(new FillError({ message: "no fill model (systemTwo.use is fake)" })),
})
