import { Context, Effect, Fiber, Layer, Ref } from "effect"

// Work that shouldn't hold up the answer (the reviewer), run on its own fiber. `drain` waits for all of it:
// called before empty-vessel exits, so a one-shot `-p` run doesn't quit halfway through saving what it learned.
export class Background extends Context.Service<
  Background,
  { readonly run: <R>(work: Effect.Effect<void, never, R>) => Effect.Effect<void, never, R>; readonly drain: Effect.Effect<void> }
>()("empty-vessel/Background") {
  static readonly layer = Layer.effect(
    Background,
    Effect.gen(function* () {
      const running = yield* Ref.make<ReadonlyArray<Fiber.Fiber<void>>>([])
      return {
        run: (work) => Effect.forkDetach(work).pipe(Effect.flatMap((fiber) => Ref.update(running, (all) => [...all, fiber]))),
        drain: Ref.get(running).pipe(Effect.flatMap(Fiber.awaitAll), Effect.asVoid),
      }
    }),
  )
}
