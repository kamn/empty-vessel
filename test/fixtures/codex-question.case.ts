import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { makeCodexSystemTwo } from "../../src/plugins/codex/codex"
import { SystemTwo } from "../../src/system-two/systemtwo"

// Run only in a child with a temporary HOME and a fake login. No real provider calls.
test("Codex advertises ask_user, returns answers to the model, rejects bad calls, and continues", () =>
  Effect.runPromise(Effect.gen(function* () {
    const requests: Array<any> = []
    const args = [
      { questions: [{ question: "Deploy?", options: ["Yes", "No"] }] },
      { questions: [] },
    ]
    const client = HttpClient.make((request) => Effect.sync(() => {
      const body = JSON.parse(new TextDecoder().decode((request.body as { body: Uint8Array }).body))
      requests.push(body)
      const index = requests.length - 1
      const item = index < args.length
        ? { type: "response.output_item.done", item: { type: "function_call", name: "ask_user", arguments: JSON.stringify(args[index]), call_id: `q${index}` } }
        : { type: "response.output_text.done", text: "Continuing with your choice." }
      const completed = { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }

      return HttpClientResponse.fromWeb(request, new Response([item, completed].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }))
    }))
    const layer = makeCodexSystemTwo("test", "low", 5).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))
    let calls = 0
    const thread: Array<unknown> = []
    const result = yield* Effect.gen(function* () {
      const two = yield* SystemTwo
      return yield* two.ask("Ask me", { thread, askUser: ({ questions }) => Effect.sync(() => {
        calls++
        return JSON.stringify(questions.map(({ question }) => ({ question, answer: "No" })))
      }) })
    }).pipe(Effect.provide(layer))

    expect(requests).toHaveLength(3)
    expect(requests[0].tools.some((t: any) => t.name === "ask_user" && t.parameters.properties.questions)).toBe(true)
    expect(requests[1].input.find((t: any) => t.type === "function_call_output").output).toContain('"answer":"No"')
    expect(requests[2].input.find((t: any) => t.call_id === "q1" && t.type === "function_call_output").output).toStartWith("invalid arguments")
    expect(calls).toBe(1)
    expect(result.text).toBe("Continuing with your choice.")
    expect(result.waitingForUser).toBeUndefined()
  })),
)
