import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { makeCodexSystemTwo } from "../../src/plugins/codex/codex"
import { type Handoff, SystemTwo } from "../../src/system-two/systemtwo"

// Run only in a child with a temporary HOME and a fake login. No real provider calls.
// A fake Codex whose first reply hands its final check to System One (finishes: true), then answers in text if asked
// again; System One's verdict is the fake handoff's.
const run = (verdict: Handoff) =>
  Effect.gen(function* () {
    const requests: Array<any> = []
    const yieldCall = { command: "bun test", finishes: true, success: "Fixed: the tests pass." }
    const client = HttpClient.make((request) => Effect.sync(() => {
      requests.push(JSON.parse(new TextDecoder().decode((request.body as { body: Uint8Array }).body)))
      const item = requests.length === 1
        ? { type: "response.output_item.done", item: { type: "function_call", name: "yield_to_system_one", arguments: JSON.stringify(yieldCall), call_id: "y0" } }
        : { type: "response.output_text.done", text: "Still broken; here is what I found." }
      const completed = { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } }
      return HttpClientResponse.fromWeb(request, new Response([item, completed].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }))
    }))

    const layer = makeCodexSystemTwo("test", "low", 5).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))
    const checked: Array<string> = []
    const result = yield* Effect.gen(function* () {
      const two = yield* SystemTwo
      return yield* two.ask("Fix it", { thread: [], handoff: (args) => Effect.sync(() => { checked.push(args.command ?? ""); return verdict }) })
    }).pipe(Effect.provide(layer))
    return { requests, checked, result }
  })

test("a final check System One passes ends the run with System Two's answer, no further model round; a failure goes back to System Two", () =>
  Effect.runPromise(Effect.gen(function* () {
    const passed = yield* run({ answer: "Fixed: the tests pass.", done: true })
    expect(passed.checked).toEqual(["bun test"])
    expect(passed.requests).toHaveLength(1) // no round to read the passing output and write "done"
    expect(passed.result).toMatchObject({ text: "Fixed: the tests pass.", done: true })

    const failed = yield* run({ output: "System One judged this a failure.\nexit 1\nTests: 1 failed" })
    expect(failed.requests).toHaveLength(2) // back to System Two, with the output
    expect(failed.requests[1].input.find((t: any) => t.type === "function_call_output" && t.call_id === "y0").output).toContain("Tests: 1 failed")
    expect(failed.result.text).toBe("Still broken; here is what I found.")
    expect(failed.result.done).toBeFalsy()
  })),
)
