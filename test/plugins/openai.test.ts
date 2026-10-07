import { expect, test } from "bun:test"
import { Effect, Redacted } from "effect"
import { SystemTwo, systemTwoFromModel } from "empty-vessel"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openAIModel } from "../../src/plugins/openai/model"
import { setupAs } from "../../src/plugins/openai/setup"
import { runSetup } from "../../src/setup"

// A fake OpenAI-compatible server: the first reply asks for a kernel cell, the second answers. No real API, no real key.
const fakeServer = () => {
  const requests: Array<any> = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push({ auth: request.headers.get("authorization"), body: await request.json() })
      const message = requests.length === 1
        ? { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "kernel", arguments: JSON.stringify({ code: "export default 1 + 1" }) } }] }
        : { content: "It's 2." }
      return Response.json({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } })
    },
  })
  return { url: `http://localhost:${server.port}/v1`, requests, stop: () => server.stop(true) }
}

test("an OpenAI-compatible model as System Two: a tool call goes through the core's loop and its result comes back; then the answer", async () => {
  const fake = fakeServer()
  const ran: Array<string> = []
  const run = Effect.gen(function* () {
    const two = yield* SystemTwo
    return yield* two.ask("What's 1 + 1?", { thread: [], kernel: (args) => Effect.sync(() => { ran.push(args.code ?? ""); return "$1 = 2" }) })
  }).pipe(Effect.provide(systemTwoFromModel(openAIModel(fake.url, "test-model", Redacted.make("test-key")), 5)))

  const result = await Effect.runPromise(run).finally(fake.stop)
  expect(ran).toEqual(["export default 1 + 1"])
  expect(result.text).toBe("It's 2.")
  expect(result.tokens).toMatchObject({ input: 20, cached: 8, output: 6 })

  const [first, second] = fake.requests
  expect(first.auth).toBe("Bearer test-key")
  expect(first.body.messages[0].role).toBe("system")
  expect(first.body.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "What's 1 + 1?" }] })
  expect(first.body.tools.map((t: any) => t.function.name)).toContain("kernel")
  expect(second.body.messages.slice(-2)).toEqual([
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "kernel", arguments: JSON.stringify({ code: "export default 1 + 1" }) } }] },
    { role: "tool", tool_call_id: "c1", content: "$1 = 2" },
  ])
})

// Setup for an OpenAI-compatible API (a copy's name here): the address, a key tried by listing the models, then a model
// picked from that list by number. A refused key isn't saved; a name the list doesn't have isn't either.
test("openai setup: the key is tried against the address given; the model is picked from the ones the server lists", async () => {
  const server = Bun.serve({ port: 0, fetch: (r) => (r.headers.get("authorization") === "Bearer good" ? Response.json({ data: [{ id: "zeta" }, { id: "alpha" }] }) : new Response("no", { status: 401 })) })
  const url = `http://localhost:${server.port}/v1`
  const setUp = async (answers: ReadonlyArray<string>) => {
    const file = join(mkdtempSync(join(tmpdir(), "empty-vessel-setup-")), "config.json")
    const said: Array<string> = [], queue = [...answers]
    await Effect.runPromise(runSetup(file, [setupAs("local")], { ask: () => queue.shift() ?? "", say: (l) => Effect.sync(() => { said.push(l) }) }))
    return { config: JSON.parse(readFileSync(file, "utf8")), said: said.join("\n") }
  }

  const good = await setUp([url, "good", "2"])
  expect(good.config.systemTwo.use).toBe("local")
  expect(good.config.plugins.local.config).toEqual({ baseUrl: url, apiKey: "good", model: "zeta" })
  expect(good.said).toContain("1. alpha")

  const refused = await setUp([url, "bad", "alpha"])
  expect(refused.said).toContain("✗ the server refused it")
  expect(refused.config.systemTwo.use).toBe("fake")

  const unknown = await setUp([url, "good", "omega"]).finally(() => server.stop(true))
  expect(unknown.said).toContain("✗ omega isn't one of them")
  expect(unknown.config.systemTwo.use).toBe("fake")
})
