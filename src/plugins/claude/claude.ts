import { Duration, Effect, Layer, Option, Schema } from "effect"
import { Ask, AskError, emit, Fill, FillError, type Hooks, jobsReminder, jsonSchemaFor, kernelInstructions, loadImage, serveTools, SystemTwo, SYSTEM_TWO_TOOLS, type ToolRelay } from "empty-vessel"

// System Two as `claude -p` (Claude Code, on its own login). Its tools are Codex's (kernel, yield_to_system_one,
// wait_for_user), and they're empty-vessel's: the core serves them to Claude over MCP (serveTools), and empty-vessel answers each
// call with the same hooks Codex's calls get (session kernel, System One, sub-agents,
// library, System One's checks). Claude keeps its own conversation; the thread holds its session id, so the next run
// (the next step, or the user's answer after wait_for_user) resumes it.

// Claude Code names an MCP server's tools mcp__<server>__<tool>; these are the ones it may use without asking.
const allowed = (relay: ToolRelay) => SYSTEM_TWO_TOOLS.map((t) => `mcp__${relay.server}__${t.name}`).join(",")

export type Reply = { type?: string; subtype?: string; result?: string; total_cost_usd?: number; structured_output?: unknown; session_id?: string; is_error?: boolean; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
// Two replies' tokens as one (a run that hit its round limit, then its wrap-up).
const sumUsage = (a: Reply, b: Reply) => ({
  input_tokens: (a.usage?.input_tokens ?? 0) + (b.usage?.input_tokens ?? 0),
  output_tokens: (a.usage?.output_tokens ?? 0) + (b.usage?.output_tokens ?? 0),
  cache_read_input_tokens: (a.usage?.cache_read_input_tokens ?? 0) + (b.usage?.cache_read_input_tokens ?? 0),
  cache_creation_input_tokens: (a.usage?.cache_creation_input_tokens ?? 0) + (b.usage?.cache_creation_input_tokens ?? 0),
})

// All the input the model read, as Codex counts it: Anthropic reports new, cache-written and cache-read input apart.
const inputOf = (r: Reply) => (r.usage?.input_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0) + (r.usage?.cache_read_input_tokens ?? 0)

// `claude -p` with none of the user's own Claude Code settings (hooks, plugins, skills), and without the API key, so it
// uses its own login.
// EMPTY_VESSEL_CLAUDE_BIN: another program in claude's place (tests use a fake one).
const bin = () => process.env.EMPTY_VESSEL_CLAUDE_BIN ?? "claude"
const spawnClaude = (args: ReadonlyArray<string>, format: ReadonlyArray<string>, env: Record<string, string>, stdin: "pipe" | "ignore" = "ignore") => {
  const { ANTHROPIC_API_KEY: _, ...rest } = process.env
  return Bun.spawn([bin(), "-p", ...args, ...format, "--setting-sources", ""], { env: { ...rest, ...env }, stdin, stdout: "pipe", stderr: "pipe" })
}

// What a run's prompt is made of: text, and images (the user's pasted ones), as Claude's content blocks.
export type Content = { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly source: { readonly type: "base64"; readonly media_type: string; readonly data: string } }

// One line of claude -p's stream: the text Claude writes next to a tool call ("Let me run the tests first") is its
// thought, shown like Codex's reasoning summary (claude -p gives no thinking text: its thinking blocks come empty); the
// result line is the reply. Anything else (progress, tool results, the final answer's own message) is nothing here.
// A web search or page fetch (Claude Code's own WebSearch / WebFetch) is `search`: it runs inside claude -p, not through
// empty-vessel, so this is the only place to see it.
export const streamLine = (line: string): { thought?: string; search?: string; result?: Reply } => {
  let e: { type?: string; message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: { query?: string; url?: string } }> } }
  try { e = JSON.parse(line) } catch { return {} }
  if (e.type === "result") return { result: e as Reply }

  const content = e.type === "assistant" ? e.message?.content ?? [] : []
  const web = content.find((c) => c.type === "tool_use" && (c.name === "WebSearch" || c.name === "WebFetch"))
  const search = web ? (web.name === "WebSearch" ? `searched the web: ${web.input?.query ?? ""}` : `read ${web.input?.url ?? "a page"}`) : undefined
  const text = content.filter((c) => c.type === "text" && c.text?.trim()).map((c) => c.text!.trim()).join("\n")
  return { ...(text && content.some((c) => c.type === "tool_use") ? { thought: text } : {}), ...(search ? { search } : {}) }
}

// A run of claude -p, streamed: thoughts go to `say` as they come, and if nothing comes for `idle` while no empty-vessel call
// is running (`busy`: waiting on empty-vessel's own work isn't going quiet), it's stopped, as a Codex request that goes quiet
// is (2 minutes).
export type Live = { readonly say: (thought: string) => void; readonly saw?: (search: string) => void; readonly busy: () => boolean; readonly idle: Duration.Input }
// Text-only assistant messages can be progress too. Hold the latest until another
// assistant message arrives, or a result tells us whether it was the final answer.
export const streamProgress = (live: Pick<Live, "say" | "saw">) => {
  let pending = ""
  const flush = (final?: string) => {
    if (pending && pending.trim() !== final?.trim()) live.say(pending)
    pending = ""
  }
  const push = (line: string) => {
    const got = streamLine(line)
    if (got.result) { flush(got.result.result); return got.result }
    let event: { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } }
    try { event = JSON.parse(line) } catch { return undefined }
    const content = event.type === "assistant" ? event.message?.content ?? [] : []
    const text = content.filter((c) => c.type === "text" && c.text?.trim()).map((c) => c.text!.trim()).join("\n")

    if (text || content.some((c) => c.type === "tool_use")) {
      flush()
      if (!got.thought) pending = text
    }

    if (got.thought) live.say(got.thought)
    if (got.search) live.saw?.(got.search)
    return undefined
  }

  return { push, finish: () => flush() }
}

// The prompt goes in on stdin as one message (--input-format stream-json), so it can hold images; text-only runs go the
// same way.
export const claudeLive = (args: ReadonlyArray<string>, env: Record<string, string>, live: Live, content: ReadonlyArray<Content>) =>
  Effect.gen(function* () {
    const proc = spawnClaude(args, ["--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], env, "pipe")
    const input = proc.stdin as import("bun").FileSink
    input.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`)
    input.end()
    const idleMs = Duration.toMillis(Duration.fromInputUnsafe(live.idle))
    let last = Date.now(), quiet = false
    const watch = setInterval(() => { if (!live.busy() && Date.now() - last > idleMs) { quiet = true; proc.kill() } }, Math.min(5_000, idleMs / 2))

    const read = async () => {
      let result: Reply | undefined, buffer = ""
      const decoder = new TextDecoder()
      const progress = streamProgress(live)
      for await (const chunk of proc.stdout) {
        last = Date.now()
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          result = progress.push(line) ?? result
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) result = progress.push(buffer) ?? result
      progress.finish()
      const err = await new Response(proc.stderr).text()
      await proc.exited
      return result ?? { is_error: true, result: quiet ? `claude -p went quiet for ${Duration.format(Duration.fromInputUnsafe(live.idle))} and was stopped` : `claude -p gave no answer: ${err.slice(-2000)}` }
    }
    const reply = yield* Effect.promise(read).pipe(Effect.onInterrupt(() => Effect.sync(() => proc.kill())), Effect.ensuring(Effect.sync(() => clearInterval(watch))))

    yield* Effect.logDebug(`claude -p run ${JSON.stringify({ session: reply.session_id, cost: reply.total_cost_usd ?? 0 })}`)
    return reply
  })

// A run of claude -p with one JSON reply at the end (fill, and the wrap-up: short, nothing to show on the way).
const claude = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const proc = spawnClaude(args, ["--output-format", "json"], env)
    const [out, err] = yield* Effect.promise(() => Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])).pipe(Effect.onInterrupt(() => Effect.sync(() => proc.kill())))
    const reply = yield* Effect.try(() => JSON.parse(out) as Reply).pipe(Effect.orElseSucceed((): Reply => ({ is_error: true, result: `claude -p gave no answer: ${(err || out).slice(-2000)}` })))

    // Its cost (the plan's API-equivalent price) and session, for evals: empty-vessel's own summary counts tokens only.
    yield* Effect.logDebug(`claude -p run ${JSON.stringify({ session: reply.session_id, cost: reply.total_cost_usd ?? 0 })}`)
    return reply
  })

// A System Two run: claude -p, resumed with a reminder while sub-agent jobs are uncollected (as for Codex), at most 3
// times. A tool call that ended the run (run.ended) gives the answer, as a finishing check or wait_for_user does for Codex.
// What empty-vessel added to the thread since Claude's last run, such as the note after Ctrl+C ("you were stopped partway;
// files may have changed"). Claude keeps its own session and only ever gets the prompt, so without this it never saw
// them: they go at the start of the next prompt. A session marker after them means they were sent.
type Marker = { claudeSession?: string }
const unsent = (thread: ReadonlyArray<unknown>) =>
  thread.slice(thread.findLastIndex((t) => (t as Marker).claudeSession) + 1)
    .flatMap((t) => ((t as { role?: string }).role === "user" ? ((t as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? "") : []))
    .filter(Boolean)
export const withUnsent = (thread: ReadonlyArray<unknown>, prompt: string) => [...unsent(thread), prompt].join("\n\n")

// When a run used all its rounds (claude -p --max-turns, documented: "exits with an error when the limit is reached"),
// it's resumed once with no tools and asked for this, so it answers instead of failing (as Codex's last round, with
// no tools, must answer).
// Skills activated after this invocation starts are not in its durable system snapshot.
const SKILL_COMPACTION = "Skill instructions survive in the current system snapshot below. After internal compaction, any skill activated later than the current system snapshot must be reloaded via kernel skill before continuing its workflow. Never rely on a compacted summary as its full instructions. If reload fails, stop and report the failure rather than proceeding. Initial user-only activations already included in this snapshot do not need reloading."

const WRAP_UP = "You've used all your tool rounds for this request. Without calling any tools, reply now: what's done, what isn't, and what's left to do."

// A claude -p run that hasn't finished after `limit` (15 minutes, as for a Codex request) is killed and reported as a
// failed System Two run: a hung process would otherwise hang the turn, and a -p run or sub-agent has no way out.
const ask = (prompt: string, hooks: Hooks, relay: ToolRelay, model: string | undefined, maxRounds: number, reasoning: string | undefined, limit: Duration.Input, live: Omit<Live, "busy">, webSearch: boolean) =>
  Effect.gen(function* () {
    const thread = hooks.thread ?? []
    const tokens = { input: 0, output: 0, cached: 0 }
    const mcp = relay.mcpConfig
    // Fetch at every CLI invocation, including job reminders and max-turn wrap-up retries.
    // The hook is a read-only snapshot; it must not consume skill replay flags.
    const common = () => {
      const system = [kernelInstructions(hooks.grants), hooks.briefing ?? "", hooks.skillContext ? SKILL_COMPACTION : "", hooks.skillContext?.() ?? ""].filter(Boolean).join("\n\n")
      return ["--system-prompt", system, "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp), ...(model ? ["--model", model] : []), ...(reasoning ? ["--effort", reasoning] : [])]
    }
    yield* emit("activity", hooks.depth ?? 0, "System Two (claude -p) is thinking")

    const notes = unsent(thread).length > 0
    // Images the user attached, with the first prompt, as Claude's image blocks (shrunk, base64).
    const images: Array<Content> = (hooks.images ?? []).map((i) => ((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mediaType, data: img.data } }))(loadImage(i.path)))
    let text = withUnsent(thread, prompt)
    for (let reminders = 0; ; reminders++) {
      const last = thread.findLast((t) => (t as { claudeSession?: string }).claudeSession) as { claudeSession: string } | undefined
      // MCP_TOOL_TIMEOUT: a cell may run up to the kernel's 10 minutes.
      // Web search: Claude Code's own WebSearch and WebFetch, the only built-in tools it gets (the rest is empty-vessel's kernel).
      const web = ["--tools", webSearch ? "WebSearch,WebFetch" : ""]
      const started = yield* claudeLive([...common(), ...web, "--allowedTools", webSearch ? `${allowed(relay)},WebSearch,WebFetch` : allowed(relay), "--max-turns", String(maxRounds), ...(last ? ["--resume", last.claudeSession] : [])], { MCP_TOOL_TIMEOUT: "660000" }, { ...live, busy: relay.busy }, [{ type: "text", text }, ...(reminders === 0 ? images : [])]).pipe(Effect.timeoutOption(limit))
      if (Option.isNone(started)) return { text: `(System Two failed: claude -p hadn't finished after ${Duration.format(Duration.fromInputUnsafe(limit))} and was stopped)`, tokens }
      const first = started.value
      const reply = first.subtype === "error_max_turns" && first.session_id
        ? yield* claude([WRAP_UP, ...common(), "--tools", "", "--disallowedTools", "mcp__*", "--max-turns", "1", "--resume", first.session_id]).pipe(Effect.map((r) => ({ ...r, usage: sumUsage(first, r) })))
        : first
      tokens.input += inputOf(reply)
      tokens.output += reply.usage?.output_tokens ?? 0
      tokens.cached += reply.usage?.cache_read_input_tokens ?? 0
      // A marker for this run: a new session, or notes it delivered (so they count as sent, even in the same session).
      if (reply.session_id && (reply.session_id !== last?.claudeSession || (notes && reminders === 0))) thread.push({ claudeSession: reply.session_id })

      const ended = relay.ended()
      if (ended) return { text: ended.answer, tokens, done: ended.done, waitingForUser: ended.waitingForUser }
      const pending = hooks.pending?.() ?? []
      if (reply.is_error || !pending.length || reminders >= 3) return { text: reply.is_error ? `(System Two failed: ${reply.result})` : (reply.result ?? ""), tokens }
      text = jobsReminder(pending)
    }
  })

// `model`: claude --model (none: Claude Code's default). `maxRounds` and `reasoning`: the config's, as for Codex
// (claude -p --max-turns, --effort: the same levels, low to max).
export const makeClaudeSystemTwo = (model?: string, maxRounds = 30, reasoning?: string, limit: Duration.Input = "15 minutes", idle: Duration.Input = "2 minutes", webSearch = false) => Layer.succeed(SystemTwo, {
  // Each run serves the tools on its own relay (the core's serveTools), closed however the run ends, its calls stopped
  // (answered, failed, or stopped by Ctrl+C).
  ask: (prompt, hooks = {}) =>
    Effect.scoped(Effect.gen(function* () {
      const relay = yield* serveTools(hooks)
      const context = yield* Effect.context<never>()
      // Claude's thoughts as they come, shown like Codex's: the first line, the rest to unfold.
      // Its web searches and page reads, shown as Codex's are.
      const saw = (search: string) => { Effect.runFork(emit("system-two", hooks.depth ?? 0, `  system two ${search}`).pipe(Effect.provideContext(context))) }
      const say = (thought: string) => { Effect.runFork(emit("system-two", hooks.depth ?? 0, `  thought: ${thought.split("\n").find((l) => l.trim())?.slice(0, 200) ?? ""}`, thought).pipe(Effect.provideContext(context))) }
      return yield* ask(prompt, hooks, relay, model, maxRounds, reasoning, limit, { say, saw, idle }, webSearch)
    })),
  // Claude Code compacts its own conversation.
  compact: (_thread, { size }) => Effect.succeed({ masked: 0, savedTokens: 0, summarized: 0, after: size, tokens: { input: 0, output: 0 } }),
})

// Fill (judge's re-check, filling in arguments) as a small Claude with no tools: its reply forced into the schema.
// Ask (src/system-two/ask.ts): one question to System Two's model (claude --model; none: Claude Code's default), with
// its reasoning (--effort), no tools, and the reply forced into the schema (--json-schema), then checked against it.
export const makeClaudeAsk = (model: string | undefined, reasoning: string) => Layer.succeed(Ask, {
  ask: (instructions, schema, input) =>
    Effect.gen(function* () {
      const reply = yield* claude([input, ...(model ? ["--model", model] : []), "--effort", reasoning, "--tools", "", "--json-schema", JSON.stringify(jsonSchemaFor(schema)), "--system-prompt", instructions])
      if (reply.is_error || reply.structured_output === undefined) return yield* Effect.fail(new AskError({ message: `claude -p: ${reply.result ?? "no structured output"}` }))

      const value = yield* Schema.decodeUnknownEffect(schema)(reply.structured_output).pipe(Effect.mapError((e) => new AskError({ message: `Claude's answer doesn't fit: ${e.message}` })))
      return { value, tokens: { input: inputOf(reply), output: reply.usage?.output_tokens ?? 0, cached: reply.usage?.cache_read_input_tokens ?? 0 } }
    }),
})

export const makeClaudeFill = (model: string) => Layer.succeed(Fill, {
  fill: (name, schema, goal) =>
    Effect.gen(function* () {
      const reply = yield* claude([goal, "--model", model, "--tools", "", "--json-schema", JSON.stringify(jsonSchemaFor(schema)), "--system-prompt", `Fill in the arguments for ${name}.`])
      if (reply.is_error || reply.structured_output === undefined) return yield* Effect.fail(new FillError({ message: `claude -p couldn't fill ${name}: ${reply.result ?? "no structured output"}` }))

      const args = yield* Schema.decodeUnknownEffect(schema)(reply.structured_output).pipe(Effect.mapError((e) => new FillError({ message: e.message })))
      return { args, tokens: { input: inputOf(reply), output: reply.usage?.output_tokens ?? 0, cached: reply.usage?.cache_read_input_tokens ?? 0 } }
    }),
})
