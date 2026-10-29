import { expect, test } from "bun:test"
import { Context, Effect, Schema } from "effect"
import { Delivery, type Chart } from "../../src/base/delivery"
import { Events } from "../../src/base/events"
import { callTool, newCallState } from "../../src/system-two/dispatch"
import { TellUserArgs } from "../../src/system-two/systemtwo"

const chart = { title: "Tests by day", points: [{ label: "Mon", value: 3 }, { label: "Tue", value: 12 }, { label: "Wed", value: 7.5 }] }
const args = { message: "This week", chart }
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(effect.pipe(
  Effect.scoped, Effect.provideContext(Context.empty() as Context.Context<Exclude<R, never>>), Effect.timeout("3 seconds"),
))
const notesOf = (notes: string[]) => Effect.provideService(Events, { emit: (event) => Effect.sync(() => { if (event.kind === "note") notes.push(event.text) }) })

test("tell_user sends its chart once through sendChart, and the message as a note", () => run(Effect.gen(function* () {
  const sent: Chart[] = []
  const notes: string[] = []

  yield* callTool("tell_user", args, {}, newCallState()).pipe(
    Effect.provideService(Delivery, { ...Delivery.defaultValue(), sendChart: (c) => Effect.sync(() => { sent.push(c) }) }),
    notesOf(notes),
  )

  expect(sent).toEqual([chart])
  expect(notes).toEqual(["This week"])
})))

test("without sendChart the note carries the chart as a text table", () => run(Effect.gen(function* () {
  const notes: string[] = []

  yield* callTool("tell_user", args, {}, newCallState()).pipe(notesOf(notes))

  expect(notes).toHaveLength(1)
  expect(notes[0]).toStartWith("This week\n\nTests by day\n")
  expect(notes[0]).toEndWith("Mon  3\nTue  12\nWed  7.5")
})))

test("a failed sendChart falls back to the text table", () => run(Effect.gen(function* () {
  const notes: string[] = []

  yield* callTool("tell_user", args, {}, newCallState()).pipe(
    Effect.provideService(Delivery, { ...Delivery.defaultValue(), sendChart: () => Effect.fail(new Error("at cap")) }),
    notesOf(notes),
  )

  expect(notes[0]).toContain("Tests by day")
})))

test("a chart has at most 12 points", () => {
  const points = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `p${i}`, value: i }))

  expect(() => Schema.decodeUnknownSync(TellUserArgs)({ message: "m", chart: { title: "t", points: points(12) } })).not.toThrow()
  expect(() => Schema.decodeUnknownSync(TellUserArgs)({ message: "m", chart: { title: "t", points: points(13) } })).toThrow()
})
