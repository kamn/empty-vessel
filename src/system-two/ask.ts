import { Context, Data, Effect, Layer, type Schema } from "effect"
import type { Tokens } from "../base/usage"

// `noModel`: there's no model to ask at all (System Two is the fake): callers stay quiet about it.
export class AskError extends Data.TaggedError("AskError")<{ message: string; noModel?: boolean }> {}

// One question to System Two's model, its answer forced into `schema` (and checked against it on the way back in,
// since it comes from outside our code): no tools, no thread, no rounds. For empty-vessel's own looks back at a turn: the
// reviewer, adoption's verdicts and proposals (src/learning/reviewer.ts, src/loop/adopt.ts). Each System Two plugin
// provides its own (src/plugins/<name>); the registry gives the chosen one's. Unlike Fill, it's the main model, with
// reasoning.
export class Ask extends Context.Service<
  Ask,
  {
    readonly ask: <S extends Schema.Top>(instructions: string, schema: S, input: string) => Effect.Effect<{ value: S["Type"]; tokens: Tokens }, AskError, S["DecodingServices"]>
  }
>()("empty-vessel/Ask") {}

export const FakeAsk = Layer.succeed(Ask, {
  ask: () => Effect.fail(new AskError({ message: "no System Two model (systemTwo.use is fake)", noModel: true })),
})
