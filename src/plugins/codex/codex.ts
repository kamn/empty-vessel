import { Data, Duration, Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { CurrentSession, SystemTwo, askFromModel, emit, fillFromModel, type Model, retryIfTemporary, systemTwoFromModel } from "empty-vessel"
import { codexSessionMirror, recordCodexUsage } from "./rollout"
import { CodexAuthError } from "./auth-store"
import { readCodexAuth } from "./auth"
export { readCodexAuth } from "./auth"

class CodexReplyError extends Data.TaggedError("CodexReplyError")<{ message: string }> {}

// The events we need from a Codex reply. Only the fields we use are checked.
const TextDone = Schema.Struct({ type: Schema.Literal("response.output_text.done"), text: Schema.String })
// A short, readable summary of the model's hidden thinking (only sent when we ask for `reasoning.summary`).
const ThinkingSummary = Schema.Struct({ type: Schema.Literal("response.reasoning_summary_text.done"), text: Schema.String })
// The model asking us to run a tool: a finished "function_call" output item.
const FunctionCall = Schema.Struct({
  type: Schema.Literal("response.output_item.done"),
  item: Schema.Struct({ type: Schema.Literal("function_call"), name: Schema.String, arguments: Schema.String, call_id: Schema.String }),
})
// A web search the model ran (Codex's hosted web_search): its queries, to show what it looked up.
const WebSearchCall = Schema.Struct({
  type: Schema.Literal("response.output_item.done"),
  item: Schema.Struct({ type: Schema.Literal("web_search_call"), action: Schema.optionalKey(Schema.Struct({ query: Schema.optionalKey(Schema.String), queries: Schema.optionalKey(Schema.Array(Schema.String)) })) }),
})
// The model's hidden thinking, as an encrypted item we can't read but can send back so it keeps its train of thought.
const ReasoningItem = Schema.Struct({
  type: Schema.Literal("response.output_item.done"),
  item: Schema.Struct({ type: Schema.Literal("reasoning"), encrypted_content: Schema.String }),
})
const Completed = Schema.Struct({
  type: Schema.Literal("response.completed"),
  response: Schema.Struct({
    usage: Schema.Struct({
      input_tokens: Schema.Number,
      output_tokens: Schema.Number,
      input_tokens_details: Schema.optionalKey(Schema.Struct({ cached_tokens: Schema.Number })),
      output_tokens_details: Schema.optionalKey(Schema.Struct({ reasoning_tokens: Schema.Number })),
    }),
  }),
})

// The reply is a stream of `data: {...}` lines (server-sent events). We wait for all of it, then read:
// the finished text from "response.output_text.done", any tool calls, and the token usage from "response.completed"
// (on this endpoint, "completed" doesn't repeat the text: its output list is empty).
// Codex's internal citation marks after a web search (U+E200 "cite" U+E202 "turn0view0" U+E201): not for people.
// The readable sources it writes (markdown links) stay.
export const withoutCitationMarks = (text: string) => text.replace(/\s?\uE200[^\uE201]*\uE201/g, "")

const readReply = (body: string) => {
  const events = body.split("\n").filter((line) => line.startsWith("data: "))
    .map((line) => { try { return JSON.parse(line.slice(6)) } catch { return undefined } }) // e.g. "data: [DONE]" isn't JSON

  const text = withoutCitationMarks(events.flatMap((e) => Option.toArray(Schema.decodeUnknownOption(TextDone)(e))).map((e) => e.text).join(""))
  const completed = events.flatMap((e) => Option.toArray(Schema.decodeUnknownOption(Completed)(e)))[0]
  const calls = events.flatMap((e) => Option.toArray(Schema.decodeUnknownOption(FunctionCall)(e))).map((e) => e.item)
  // Reasoning items are kept exactly as received (Pi does the same): the server needs them unchanged.
  const reasoning: Array<unknown> = events.filter((e) => Option.isSome(Schema.decodeUnknownOption(ReasoningItem)(e))).map((e) => e.item)
  const thinking = events.flatMap((e) => Option.toArray(Schema.decodeUnknownOption(ThinkingSummary)(e))).map((e) => e.text).join("\n")
  const searches = events.flatMap((e) => Option.toArray(Schema.decodeUnknownOption(WebSearchCall)(e))).map((e) => e.item.action?.queries?.join(" · ") ?? e.item.action?.query ?? "(a search)")

  return completed && { text, calls, reasoning, thinking, searches, usage: completed.response.usage }
}

export class CodexStallError extends Data.TaggedError("CodexStallError")<{ message: string }> {}

// The whole streamed reply as text, failing (and saying so in the log) if it goes silent for `idle`.
export const readWithin = <E>(stream: Stream.Stream<Uint8Array, E>, idle: Duration.Input) => {
  const stalled = new CodexStallError({ message: `System Two's request sent nothing for ${Duration.format(Duration.fromInputUnsafe(idle))}` })
  return stream.pipe(
    Stream.timeoutOrElse({ duration: idle, orElse: () => Stream.fromEffect(emit("error", 0, `${stalled.message}: retrying`)).pipe(Stream.drain, Stream.concat(Stream.fail(stalled))) }),
    Stream.decodeText(),
    Stream.mkString,
  )
}

// One request to the Codex endpoint with native login (or read-only CLI fallback); returns the parsed reply (text, tool calls, usage).
// `store: false` means the server keeps nothing, so callers resend the whole conversation each time.
// `sessionId` goes in the `session-id` header: ChatGPT picks the server (and so the prompt cache) from it, not from
// the body's prompt_cache_key. Without it, cached_tokens was 0 on every request.
// A stream that sends nothing for this long is stuck (a live one sends events every few seconds, even while the model
// thinks): give up on it and try again, instead of waiting out the whole request (one run sat 8 minutes on a silent
// request, 2026-09-28). The overall limit stays as a safety net for replies that keep streaming.
const IDLE = Duration.minutes(2)
export const postCodex = (client: HttpClient.HttpClient, body: Record<string, unknown>, sessionId?: string, idle: Duration.Input = IDLE) =>
  Effect.gen(function* () {
    const { token, accountId } = yield* readCodexAuth
    const response = yield* HttpClientRequest.post("https://chatgpt.com/backend-api/codex/responses").pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeaders({ "chatgpt-account-id": accountId, originator: "empty-vessel", "OpenAI-Beta": "responses=experimental", accept: "text/event-stream",
        ...(sessionId ? { "session-id": sessionId } : {}) }),
      HttpClientRequest.bodyJsonUnsafe({ ...body, store: false, stream: true }),
      client.execute,
    )

    if (response.status === 401 || response.status === 403) {
      return yield* Effect.fail(new CodexAuthError({ message: "Codex denied this login or account access. Run `empty-vessel login codex` to reconnect; no fallback account was used." }))
    }

    const reply = readReply(yield* readWithin(response.stream, idle))
    if (!reply) return yield* Effect.fail(new CodexReplyError({ message: "no response.completed event in the Codex reply" }))
    return reply
  }).pipe(
    // A stalled connection can wait forever (one run hung 12 minutes: SWE pass 1, dayjs-857): the idle limit above
    // catches a silent stream; this catches one that trickles forever. A stall, a timeout, a dropped connection or a
    // 5xx/429 gets one more try.
    Effect.timeout("15 minutes"),
    retryIfTemporary,
  )

type Usage = { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens: number }; output_tokens_details?: { reasoning_tokens: number } }
// One request's usage: how much it sent, how much of that the cache served, what it wrote, how much was thinking.
const requestUsage = (u: Usage) => ({ input: u.input_tokens, cached: u.input_tokens_details?.cached_tokens ?? 0, output: u.output_tokens, thinking: u.output_tokens_details?.reasoning_tokens ?? 0 })

// Codex as a model (the core runs the request loop: src/system-two/loop.ts). The core's thread is already in the
// Responses API's shape, so it goes as it is. `reasoning`: how hard it thinks (none: a small model that doesn't).
// `webSearch`: Codex's hosted web_search with the tools (OpenAI runs the search, the reply cites its sources).
// Tools aren't strict: every call is checked against its own Schema instead (src/system-two/dispatch.ts).
export const codexModel = (client: HttpClient.HttpClient, model: string, reasoning?: string, webSearch = false): Model => ({
  name: model,
  complete: ({ instructions, thread, tools, cacheKey, schema }) =>
    postCodex(client, {
      model, instructions, input: thread,
      tools: tools.length ? [...tools.map((t) => ({ type: "function", ...t, strict: false })), ...(webSearch ? [{ type: "web_search" }] : [])] : [],
      prompt_cache_key: cacheKey,
      // summary: a readable gist of its thinking, for the debug trace; its thinking comes back (encrypted) so it can be
      // sent back next round, or `store: false` would have it re-think from scratch every round.
      ...(reasoning ? { reasoning: { effort: reasoning, summary: "auto" }, include: ["reasoning.encrypted_content"] } : {}),
      // One structured answer (Ask, Fill): strict, so the model fills every field (not strict, gpt-6-luna left fields out).
      ...(schema ? { text: { format: { type: "json_schema", name: schema.name, schema: schema.schema, strict: true } } } : {}),
    }, cacheKey).pipe(Effect.tap((r) => Effect.gen(function* () {
      const session = yield* CurrentSession
      if (session) yield* recordCodexUsage(session.key, model, requestUsage(r.usage))
    })), Effect.map((r) => ({
      text: r.text, keep: r.reasoning, thinking: r.thinking, searches: r.searches, usage: requestUsage(r.usage),
      calls: r.calls.map((c) => ({ id: c.call_id, name: c.name, arguments: c.arguments })),
    }))),
})

// System Two through your ChatGPT plan, via the endpoint the Codex app uses (not OpenAI's public API), the core's loop
// around it. Fails at startup if Codex isn't logged in; re-reads the login on every call to pick up Codex's refreshes.
export const makeCodexSystemTwo = (model: string, reasoning: string, maxRounds: number, webSearch = false) =>
  Layer.unwrap(Effect.gen(function* () {
    yield* readCodexAuth
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
    const base = systemTwoFromModel(codexModel(client, model, reasoning, webSearch), maxRounds)
    return Layer.effect(SystemTwo, Effect.gen(function* () {
      const system = yield* SystemTwo
      return { ...system, sessionMirror: codexSessionMirror }
    })).pipe(Layer.provide(base))
  }))

// Ask and Fill: the core's (one structured request), on Codex's main model with its reasoning, and on the fill model.
const withClient = (make: (client: HttpClient.HttpClient) => Layer.Layer<any>) =>
  Layer.unwrap(HttpClient.HttpClient.pipe(Effect.map((c) => make(c.pipe(HttpClient.filterStatusOk)))))
export const makeCodexAsk = (model: string, reasoning: string) => withClient((c) => askFromModel(codexModel(c, model, reasoning)))
export const makeCodexFill = (model: string) => withClient((c) => fillFromModel(codexModel(c, model)))
