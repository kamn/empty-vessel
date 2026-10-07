import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Ask, Fill, type Model, type ModelRequest } from "empty-vessel"
import { askFromModel, fillFromModel } from "../../src/system-two/structured"

// A fake model that answers every request with `text`, and keeps what it was asked.
const fake = (text: string) => {
  const asked: Array<ModelRequest> = []
  const model: Model = { name: "fake", complete: (r) => Effect.sync(() => { asked.push(r); return { text, calls: [], keep: [], thinking: "", searches: [], usage: { input: 7, cached: 2, output: 3, thinking: 0 } } }) }
  return { model, asked }
}
const Answer = Schema.Struct({ verdict: Schema.Literals(["yes", "no"]), why: Schema.String })

test("Ask from a model: one request, no tools, the schema strict, the reply decoded; a reply that doesn't fit is an AskError", async () => {
  const { model, asked } = fake(JSON.stringify({ verdict: "yes", why: "it works" }))
  const asking = (m: Model) => Effect.runPromise(Ask.use((a) => a.ask("Judge it.", Answer, "the turn")).pipe(Effect.provide(askFromModel(m)), Effect.result))

  const ok = await asking(model)
  expect(ok._tag === "Success" && ok.success).toEqual({ value: { verdict: "yes", why: "it works" }, tokens: { input: 7, output: 3, cached: 2 } })
  expect(asked[0]).toMatchObject({ instructions: "Judge it.", tools: [], schema: { name: "answer" } })
  expect((asked[0]!.schema!.schema as any).additionalProperties).toBe(false)

  const bad = await asking(fake(JSON.stringify({ verdict: "maybe", why: "" })).model)
  expect(bad._tag === "Failure" && bad.failure._tag).toBe("AskError")
})

test("Fill from a model: the tool's arguments from the request, named after the tool", async () => {
  const { model, asked } = fake(JSON.stringify({ plugin: "utc" }))
  const filled = await Effect.runPromise(Fill.use((f) => f.fill("findTest", Schema.Struct({ plugin: Schema.String }), "tests for the utc plugin")).pipe(Effect.provide(fillFromModel(model))))
  expect(filled.args).toEqual({ plugin: "utc" })
  expect(asked[0]).toMatchObject({ instructions: 'Fill in the arguments for the "findTest" tool from the user\'s request.', schema: { name: "findTest" } })
})
