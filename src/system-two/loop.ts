import { randomUUIDv7 } from "bun"
import { Effect, Layer, Option } from "effect"
import { emit } from "../base/events"
import { imageItem } from "../base/images"
import type { Tokens } from "../base/usage"
import { callTool, fromUser, jobsReminder, newCallState, systemTwoTools } from "./dispatch"
import { KERNEL_INSTRUCTIONS, kernelInstructions } from "./instructions"
import { type CompactOptions, type Hooks, SystemTwo } from "./systemtwo"
import { lastTurnStart, maskOutput, oldOutputs, SUMMARY_REQUEST } from "./thread"

// System Two from a model: the core runs the request loop,
// like Pi's (ask, run the tool calls the model wants, send the results back, repeat until it answers), and a model plugin
// only sends one request and reads its reply. The thread is the core's, in Responses-style items (messages with
// input_text / output_text, function_call, function_call_output; anything else a model returns, e.g. its encrypted
// reasoning, is kept as it came): sessions save it, resume reads it, compaction shortens it. A plugin sends it in its
// provider's shape (Codex: as it is).

// One request: empty-vessel's instructions, the thread so far, the tools (none: it must answer), the prompt-cache key (the
// session's, so a resumed session reuses its cache), and, for one structured answer (Ask, Fill), the JSON schema its
// reply must fit (strict: every field required).
export type ModelTool = { readonly name: string; readonly description: string; readonly parameters: unknown }
export type ModelRequest = {
  readonly instructions: string
  readonly thread: ReadonlyArray<unknown>
  readonly tools: ReadonlyArray<ModelTool>
  readonly cacheKey?: string
  readonly schema?: { readonly name: string; readonly schema: unknown }
}
// Its reply: the text, the tool calls (arguments as the model wrote them, JSON), items to keep in the thread before the
// calls or the answer (its reasoning, so it keeps its train of thought), a readable gist of its thinking and its web
// searches (to show), and the tokens (`input`: the whole request, i.e. how big the thread is now).
export type ModelCall = { readonly id: string; readonly name: string; readonly arguments: string }
export type ModelReply = {
  readonly text: string
  readonly calls: ReadonlyArray<ModelCall>
  readonly keep: ReadonlyArray<unknown>
  readonly thinking: string
  readonly searches: ReadonlyArray<string>
  readonly usage: Required<Tokens>
}
// A model: its name (for "System Two (name) is thinking") and one request. A failure fails the run (shown, as a stand-in reply).
export type Model = { readonly name: string; readonly complete: (request: ModelRequest) => Effect.Effect<ModelReply, unknown> }

// Thread items, in the core's format.
export const userItem = (text: string, images: ReadonlyArray<unknown> = []) => ({ role: "user", content: [{ type: "input_text", text }, ...images] })
const said = (text: string) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] })

const addUsage = (total: Required<Tokens>, u: Required<Tokens>) => ({ input: total.input + u.input, cached: total.cached + u.cached, output: total.output + u.output, thinking: total.thinking + u.thinking })

// System Two from a model. `maxRounds`: requests per run; the last has no tools, so it must answer.
export const systemTwoFromModel = (model: Model, maxRounds: number) => {
  // The cache key tells the provider these requests share a conversation, so it can reuse its cache of their shared
  // beginning. The loop passes the session id (like Pi), so a resumed session keeps its key; this is the fallback.
  const defaultKey = randomUUIDv7()

  // One run: its hooks, the thread it appends to (the session's, so the next run continues it), and the tool calls'
  // shared state (whether System One still shortens long output, and what it hid).
  const call = (prompt: string, hooks: Hooks = {}) =>
    Effect.gen(function* () {
      const thread = hooks.thread ?? []
      const state = newCallState(hooks.stash)
      // empty-vessel's instructions, then the briefing (the project's instructions and what empty-vessel learned): the same all
      // session, so the start of every request stays identical, good for prompt caching.
      // What it's told of the kernel names only what the kernel grants (hooks.grants; everything: the usual text).
      const told = kernelInstructions(hooks.grants), tools = systemTwoTools(hooks.grants)
      const instructions = hooks.briefing ? `${told}\n\n${hooks.briefing}` : told
      // Images the user attached, with the prompt (shrunk, base64). ponytail: they stay in the thread and go with every
      // later request until compaction summarizes them away.
      thread.push(userItem(prompt, (hooks.images ?? []).map((i) => imageItem(i.path))))
      let tokens: Required<Tokens> = { input: 0, cached: 0, output: 0, thinking: 0 }
      let reminders = 0 // how often it was told about uncollected jobs this run

      for (let round = 0; ; round++) {
        yield* emit("activity", hooks.depth ?? 0, `System Two (${model.name}) is thinking${round ? ` · round ${round + 1}` : ""}`)
        const reply = yield* model.complete({ instructions, thread, tools: round < maxRounds - 1 ? tools : [], cacheKey: hooks.cacheKey ?? defaultKey })
        tokens = addUsage(tokens, reply.usage)
        if (reply.thinking) yield* emit("system-two", hooks.depth ?? 0, `  thought: ${reply.thinking.split("\n").find((l) => l.trim())?.replace(/\*\*/g, "") ?? ""}`, reply.thinking)
        for (const q of reply.searches) yield* emit("system-two", hooks.depth ?? 0, `  system two searched the web: ${q}`)
        // Debug trace, one JSON line per round and per tool call, so a run can be replayed step by step (evals read it).
        yield* Effect.logDebug(`system two round ${JSON.stringify({ round, toolCalls: reply.calls.length, usage: reply.usage, thinking: reply.thinking, text: reply.text })}`)

        if (reply.calls.length === 0) {
          thread.push(...reply.keep, said(reply.text)) // its answer stays in the thread for the next turn

          // The user wrote while it was answering: it reads that before it's done (when there's a round left).
          const steered = hooks.inbox && round < maxRounds - 1 ? yield* hooks.inbox : []
          if (steered.length) {
            if (reply.text.trim()) yield* emit("note", hooks.depth ?? 0, reply.text)
            thread.push(userItem(fromUser(steered)))
            continue
          }

          // Not finished while sub-agent jobs are uncollected: they'd be lost (or cancelled) when the run ends.
          const pending = hooks.pending?.() ?? []
          if (pending.length && round < maxRounds - 1 && reminders++ < 3) {
            if (reply.text.trim()) yield* emit("note", hooks.depth ?? 0, reply.text)
            thread.push(userItem(jobsReminder(pending)))
            continue
          }
          return { text: reply.text, tokens, size: reply.usage.input }
        }

        // Keep its train of thought: what it kept goes back in, before the tool calls it led to. Each call runs through
        // the core's tool host; the call and its result go in the thread. A finishing check or waiting for the user ends
        // the run, and the thread stays valid: the call, its result, and the answer given.
        // User-facing commentary alongside tools is progress, not a final reply.
        if (reply.text.trim()) yield* emit("note", hooks.depth ?? 0, reply.text)
        thread.push(...reply.keep)
        for (const c of reply.calls) {
          const parsed = (() => { try { return JSON.parse(c.arguments) } catch { return undefined } })()
          const result = yield* callTool(c.name, parsed, hooks, state)
          const asked = { type: "function_call", name: c.name, arguments: c.arguments, call_id: c.id }

          if ("answer" in result) {
            const told = result.waitingForUser ? "Waiting for user input; the task is not marked complete." : `System One ran it: ${result.done ? "passed, and the task is finished" : "failed"}. Your message went to the user.`
            thread.push(asked, { type: "function_call_output", call_id: c.id, output: told }, said(result.answer))
            return { text: result.answer, tokens, done: result.done, waitingForUser: result.waitingForUser, size: reply.usage.input }
          }
          thread.push(asked, { type: "function_call_output", call_id: c.id, output: result.output })
        }
      }
    })

  // Compaction, Pi-style funnel: first hide old tool outputs System One says aren't needed any more (cheap, nothing lost:
  // more_output brings them back), and only if that's not enough, replace everything before the last turn with a
  // structured summary written by the model. The last turn is always kept as it is.
  const compact = (thread: Array<unknown>, { score, stash, size, target }: CompactOptions) =>
    Effect.gen(function* () {
      const keepFrom = lastTurnStart(thread)
      const found = oldOutputs(thread, keepFrom).sort((a, b) => b.chars - a.chars).slice(0, 60) // the biggest, one System One call
      const scores = found.length ? yield* score(found.map((f) => f.label)) : []

      let saved = 0, masked = 0
      found.forEach((f, i) => {
        if ((scores[i] ?? 1) >= 0.3) return // conservative: hide only what System One is fairly sure isn't needed
        saved += maskOutput(thread, f, stash)
        masked++
      })
      const savedTokens = Math.round(saved / 4) // ~4 characters per token; the next request reports the exact size
      if (size - savedTokens <= target || keepFrom === 0) return { masked, savedTokens, summarized: 0, after: size - savedTokens, tokens: { input: 0, output: 0 } }

      // If the summary request fails, keep what hiding outputs achieved: compaction must never break a turn.
      const asked = yield* Effect.option(model.complete({ instructions: KERNEL_INSTRUCTIONS, thread: [...thread.slice(0, keepFrom), userItem(SUMMARY_REQUEST)], tools: [], cacheKey: defaultKey }))
      if (Option.isNone(asked)) return { masked, savedTokens, summarized: 0, after: size - savedTokens, tokens: { input: 0, output: 0 } }
      const reply = asked.value
      thread.splice(0, keepFrom, userItem(`Summary of the conversation so far (older messages were compacted):\n\n${reply.text}`))
      const after = Math.round(JSON.stringify(thread).length / 4)
      return { masked, savedTokens, summarized: keepFrom, after, tokens: { input: reply.usage.input, output: reply.usage.output, cached: reply.usage.cached } }
    })

  return Layer.succeed(SystemTwo, SystemTwo.of({
    compact,
    ask: (prompt, hooks) =>
      call(prompt, hooks).pipe(
        // ponytail: a failed call becomes a visible stand-in reply; add retries once real failures show up
        Effect.catch((e) => emit("error", 0, `system two (${model.name}) failed: ${e}`).pipe(Effect.as({ text: `(System Two failed: ${e})`, tokens: { input: 0, output: 0 } }))),
      ),
  }))
}
