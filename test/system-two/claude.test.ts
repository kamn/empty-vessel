import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect } from "effect"
import { Events } from "../../src/base/events"
import { flush, newWire, receive, send, type Wire } from "../../src/system-two/wire"
import { claudeLive, streamLine, streamProgress, withUnsent } from "../../src/plugins/claude/claude"
import { answer, newRun, serve, stopCalls } from "../../src/system-two/relay"
import type { Hooks } from "../../src/system-two/systemtwo"

// Claude's tool calls, answered as Codex's are (src/plugins/claude/claude.ts), with stand-in hooks.
const run = (tool: string, args: unknown, hooks: Hooks, r = newRun()) => Effect.runPromise(answer(tool, args, hooks, r))

test("kernel: runs the cell, tells onCommand, and returns the output", async () => {
  const seen: Array<string> = []
  const hooks: Hooks = { kernel: (a) => Effect.succeed(`ran ${a.code}`), onCommand: (c) => Effect.sync(() => { seen.push(c.output) }) }

  expect(await run("kernel", { code: "export default 1" }, hooks)).toBe("ran export default 1")
  expect(seen).toEqual(["ran export default 1"])
  expect(await run("kernel", { code: 7 }, hooks)).toStartWith("invalid arguments")
})

test("long output: shortened by prune, the full text back with more_output, then no more pruning", async () => {
  const long = "x".repeat(9000), stash = new Map<string, string>(), r = newRun(stash)
  const hooks: Hooks = { kernel: () => Effect.succeed(long), prune: () => Effect.succeed("short"), stash }

  const shortened = await run("kernel", { code: "a" }, hooks, r)
  expect(shortened).toContain('more_output { id: "out1" }')
  expect(stash.get("out1")).toBe(long)

  expect(await run("more_output", { id: "out1" }, hooks, r)).toBe(long)
  expect(await run("kernel", { code: "a" }, hooks, r)).toBe(long) // System One's guess was wrong once: no more shortening
})

test("yield: a failed check goes back to Claude; a finishing one ends the run", async () => {
  const failing: Hooks = { handoff: () => Effect.succeed({ output: "3 tests failed" }) }
  const r1 = newRun()
  expect(await run("yield_to_system_one", { command: "bun test", finishes: true }, failing, r1)).toBe("3 tests failed")
  expect(r1.ended).toBeUndefined()

  const passing: Hooks = { handoff: () => Effect.succeed({ answer: "done", done: true }) }
  const r2 = newRun()
  expect(await run("yield_to_system_one", { command: "bun test", finishes: true }, passing, r2)).toContain("This ends your turn")
  expect(r2.ended).toEqual({ answer: "done", done: true })
})

test("wait_for_user: not while sub-agent jobs are uncollected; otherwise ends the run with the question", async () => {
  const r1 = newRun()
  expect(await run("wait_for_user", { message: "Which name?" }, { pending: () => ["job-1 (running)"] }, r1)).toStartWith("Collect or cancel")
  expect(r1.ended).toBeUndefined()

  const r2 = newRun()
  await run("wait_for_user", { message: "Which name?" }, {}, r2)
  expect(r2.ended).toEqual({ answer: "Which name?", done: false, waitingForUser: true })
})

// Two calls sent at once over the socket are still answered one at a time: two cells at once would clash in the kernel.
test("calls over the socket are answered one at a time", async () => {
  const path = `/tmp/empty-vessel-test-${process.pid}-lock.sock`
  let running = 0, most = 0
  const hooks: Hooks = { kernel: () => Effect.gen(function* () { most = Math.max(most, ++running); yield* Effect.sleep("30 millis"); running-- ; return "ok" }) }
  const server = serve(path, hooks, newRun())

  const replies: Array<unknown> = []
  const socket = await Bun.connect<Wire>({ unix: path, data: newWire(), socket: { data: (s, c) => { replies.push(...receive(s, c)) }, drain: flush } })
  send(socket, { id: 1, tool: "kernel", args: { code: "a" } })
  send(socket, { id: 2, tool: "kernel", args: { code: "b" } })
  while (replies.length < 2) await Bun.sleep(10)

  socket.end()
  server.stop(true)
  rmSync(path, { force: true })
  expect(most).toBe(1)
})

// A connection to a served run, sending calls and collecting replies.
const connect = async (path: string) => {
  const replies: Array<{ id: number; text: string }> = []
  const socket = await Bun.connect<Wire>({ unix: path, data: newWire(), socket: { data: (s, c) => { replies.push(...(receive(s, c) as Array<{ id: number; text: string }>)) }, drain: flush } })
  return { socket, replies }
}

test("calls run in empty-vessel's context (events go to its Events, not stdout); a call that crashes still gets a reply", async () => {
  const path = `/tmp/empty-vessel-test-${process.pid}-ctx.sock`
  const seen: Array<string> = []
  const context = Context.make(Events, { emit: (e) => Effect.sync(() => { seen.push(`${e.kind}: ${e.text}`) }) })
  const hooks: Hooks = { kernel: (a) => (a.code === "crash" ? Effect.die(new Error("boom")) : Effect.succeed("ok")) }
  const server = serve(path, hooks, newRun(), context)

  const { socket, replies } = await connect(path)
  send(socket, { id: 1, tool: "kernel", args: { code: "fine" } })
  send(socket, { id: 2, tool: "kernel", args: { code: "crash" } })
  while (replies.length < 2) await Bun.sleep(10)
  socket.end()
  server.stop(true)
  rmSync(path, { force: true })

  expect(seen.some((s) => s.startsWith("system-two:"))).toBe(true) // the kernel call's event reached empty-vessel's Events
  expect(replies.find((r) => r.id === 2)?.text).toContain("boom") // an error reply, not silence (Claude would wait 11 minutes)
})

test("when the run ends, calls still running are stopped (their cells don't run on)", async () => {
  const path = `/tmp/empty-vessel-test-${process.pid}-stop.sock`
  let stopped = false
  const hooks: Hooks = { kernel: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => { stopped = true }))) }
  const run = newRun()
  const server = serve(path, hooks, run)

  const { socket } = await connect(path)
  send(socket, { id: 1, tool: "kernel", args: { code: "long" } })
  while (run.calls.size === 0) await Bun.sleep(10)
  await Effect.runPromise(stopCalls(run))
  socket.end()
  server.stop(true)
  rmSync(path, { force: true })
  expect(stopped).toBe(true)
})

test("once a call has ended the run (a finishing check passed), later calls aren't run", async () => {
  let ran = false
  const r = newRun()
  const hooks: Hooks = { handoff: () => Effect.succeed({ answer: "done", done: true }), kernel: () => Effect.sync(() => { ran = true; return "changed a file" }) }

  await run("yield_to_system_one", { command: "bun test", finishes: true }, hooks, r)
  expect(await run("kernel", { code: "export default 1" }, hooks, r)).toContain("this call wasn't run")
  expect(ran).toBe(false) // no file changes after the user was told the task is done
})

test("the stop note empty-vessel adds after Ctrl+C reaches Claude at the start of its next prompt, once", () => {
  const note = { role: "user", content: [{ type: "input_text", text: "(The user stopped your work partway.)" }] }
  // Stopped after Claude's last run: the note comes after its session marker, so it's sent with the next prompt.
  expect(withUnsent([{ claudeSession: "s1" }, note], "Goal: next")).toBe("(The user stopped your work partway.)\n\nGoal: next")
  // Already sent (a marker after it): not sent again.
  expect(withUnsent([{ claudeSession: "s1" }, note, { claudeSession: "s1" }], "Goal: next")).toBe("Goal: next")
  // Nothing new: just the prompt.
  expect(withUnsent([{ claudeSession: "s1" }], "Goal: next")).toBe("Goal: next")
})

test("stream lines: text next to a tool call is a thought; the result line is the reply; empty thinking is nothing", () => {
  const assistant = (content: unknown[]) => JSON.stringify({ type: "assistant", message: { content } })
  expect(streamLine(assistant([{ type: "text", text: "Let me run the tests first." }, { type: "tool_use", name: "mcp__kernel__kernel" }]))).toEqual({ thought: "Let me run the tests first." })
  expect(streamLine(assistant([{ type: "thinking", thinking: null }]))).toEqual({})
  expect(streamLine(assistant([{ type: "text", text: "All done." }]))).toEqual({}) // the answer itself: it comes with the result
  expect(streamLine(JSON.stringify({ type: "result", subtype: "success", result: "ok", session_id: "s" }))).toEqual({ result: { type: "result", subtype: "success", result: "ok", session_id: "s" } })
  expect(streamLine("not json")).toEqual({})
})

test("idle: a claude -p that goes quiet (no events, no empty-vessel call running) is stopped; while a call runs it isn't", async () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-fake-claude-"))
  const fake = join(dir, "claude")
  writeFileSync(fake, `#!/bin/sh\necho '{"type":"system","subtype":"init"}'\nsleep 3\necho '{"type":"result","subtype":"success","result":"late","session_id":"s"}'\n`)
  chmodSync(fake, 0o755)
  process.env.EMPTY_VESSEL_CLAUDE_BIN = fake
  try {
    const quiet = await Effect.runPromise(claudeLive([], {}, { say: () => {}, busy: () => false, idle: "1 second" }, [{ type: "text", text: "hi" }]))
    expect(quiet.is_error).toBe(true)
    expect(quiet.result).toContain("went quiet")

    const busy = await Effect.runPromise(claudeLive([], {}, { say: () => {}, busy: () => true, idle: "1 second" }, [{ type: "text", text: "hi" }]))
    expect(busy.result).toBe("late") // a empty-vessel call was running: waiting on it isn't going quiet
  } finally { delete process.env.EMPTY_VESSEL_CLAUDE_BIN }
}, 20_000)

test("stream lines: Claude Code's own web search and page fetch are shown (they run inside claude -p, not through empty-vessel)", () => {
  const assistant = (content: unknown[]) => JSON.stringify({ type: "assistant", message: { content } })
  expect(streamLine(assistant([{ type: "tool_use", name: "WebSearch", input: { query: "latest bun release" } }]))).toEqual({ search: "searched the web: latest bun release" })
  expect(streamLine(assistant([{ type: "text", text: "Checking the blog." }, { type: "tool_use", name: "WebFetch", input: { url: "https://bun.com/blog" } }]))).toEqual({ thought: "Checking the blog.", search: "read https://bun.com/blog" })
})

test("Claude text-only progress survives until the next tool, without repeating the final answer", () => {
  const said: string[] = []
  const stream = streamProgress({ say: (text) => said.push(text) })
  const assistant = (content: unknown[]) => JSON.stringify({ type: "assistant", message: { content } })
  stream.push(assistant([{ type: "text", text: "I am checking the renderer." }]))
  stream.push(JSON.stringify({ type: "system", message: "heartbeat" }))
  stream.push(assistant([{ type: "tool_use", name: "kernel" }]))
  expect(said).toEqual(["I am checking the renderer."])
  stream.push(assistant([{ type: "text", text: "Now testing." }, { type: "tool_use", name: "kernel" }]))
  stream.push(assistant([{ type: "text", text: "Finished." }]))
  expect(stream.push(JSON.stringify({ type: "result", result: "Finished." }))?.result).toBe("Finished.")
  stream.finish()
  expect(said).toEqual(["I am checking the renderer.", "Now testing."])
})

test("Claude retains the last progress message if its stream ends early", () => {
  const said: string[] = []
  const stream = streamProgress({ say: (text) => said.push(text) })
  stream.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Still investigating." }] } }))
  stream.push("invalid json")
  stream.finish()
  stream.finish()
  expect(said).toEqual(["Still investigating."])
})
