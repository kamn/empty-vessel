import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Events } from "../../src/base/events"
import { CurrentSession, logEntries, makeSession, SESSIONS } from "../../src/base/session"
import { diskStore } from "../../src/base/store"
import { loadConversation, saveConversation } from "../../src/loop/resume"
import { newConversation } from "../../src/loop/turnkit"
import { type Model, systemTwoFromModel } from "../../src/system-two/loop"
import { SystemTwo } from "../../src/system-two/systemtwo"

const usage = { input: 1, cached: 0, output: 1, thinking: 0 }

// System Two calls three tools in one round, then answers.
const scripted: Model = {
  name: "fake",
  complete: (r) => Effect.sync(() => r.thread.some((i: any) => i.type === "function_call_output")
    ? { text: "all done", calls: [], keep: [], thinking: "", searches: [], usage }
    : {
      text: "", keep: [], thinking: "", searches: [], usage,
      calls: [
        { id: "c1", name: "kernel", arguments: JSON.stringify({ code: "export default 1" }) },
        { id: "c2", name: "tell_user", arguments: JSON.stringify({ message: "halfway" }) },
        { id: "c3", name: "kernel", arguments: JSON.stringify({ code: "export default 3" }) },
      ],
    }),
}

test("each System Two tool call is in the session file, synced, before any client sees it; resume rebuilds the same thread", async () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-steps-"))
  const conversation = newConversation()
  const seen: Array<{ kind: string; calls: number }> = []

  const session = await Effect.runPromise(Effect.gen(function* () {
    const session = yield* makeSession(SESSIONS)
    const calls = () => logEntries(readFileSync(join(session.dir, "main.jsonl"), "utf8")).filter((e) => e.role === "call" && !e.started).length
    const events = { emit: (e: { kind: string }) => Effect.sync(() => { if (e.kind !== "activity") seen.push({ kind: e.kind, calls: calls() }) }) }

    const systemTwo = yield* SystemTwo
    const hooks = { thread: conversation.thread, stash: conversation.stash, kernel: (a: { code?: string }) => Effect.succeed(`ran ${a.code}`) }
    const answer = yield* systemTwo.ask("Goal: count", hooks).pipe(Effect.provideService(CurrentSession, session), Effect.provideService(Events, events))
    expect(answer.text).toBe("all done")

    yield* saveConversation(session, conversation)
    return session
  }).pipe(Effect.provide(systemTwoFromModel(scripted, 5)), Effect.provide(diskStore(home))))

  // Each call's own event came after its entry: the result line, the note, the result line.
  expect(seen).toEqual([{ kind: "system-two", calls: 1 }, { kind: "note", calls: 2 }, { kind: "system-two", calls: 3 }])

  const text = readFileSync(join(session.dir, "main.jsonl"), "utf8")
  const steps = logEntries(text).filter((e) => e.role === "call" && !e.started)
  expect(steps.map((e) => [e.tool, e.args, e.output])).toEqual([
    ["kernel", { code: "export default 1" }, "ran export default 1"],
    ["tell_user", { message: "halfway" }, "The user has it. Keep working."],
    ["kernel", { code: "export default 3" }, "ran export default 3"],
  ])
  // Each started first: its arguments are in the file before it runs, so a restart knows which call it cut off.
  expect(logEntries(text).filter((e) => e.role === "call").map((e) => e.started === true ? "started" : "done")).toEqual(["started", "done", "started", "done", "started", "done"])
  const seqs = steps.map((e) => e.seq as number)
  expect(seqs).toEqual(seqs.toSorted((a, b) => a - b))

  // The thread rebuilt from the file is the one System Two had, with the call entries in the file too.
  expect(loadConversation(session.dir).thread).toEqual(JSON.parse(JSON.stringify(conversation.thread)))
})

test("a call that ends the run is recorded with its answer; outside a session nothing is written and the call still works", async () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-steps-"))
  const { callTool, newCallState } = await import("../../src/system-two/dispatch")

  const outside = await Effect.runPromise(callTool("wait_for_user", { message: "which one?" }, {}, newCallState()))
  expect(outside).toEqual({ answer: "which one?", done: false, waitingForUser: true })

  const session = await Effect.runPromise(Effect.gen(function* () {
    const session = yield* makeSession(SESSIONS)
    yield* callTool("wait_for_user", { message: "which one?" }, {}, newCallState()).pipe(Effect.provideService(CurrentSession, session))
    return session
  }).pipe(Effect.provide(diskStore(home))))

  const [step] = logEntries(readFileSync(join(session.dir, "main.jsonl"), "utf8")).filter((e) => e.role === "call" && !e.started)
  expect(step).toMatchObject({ tool: "wait_for_user", args: { message: "which one?" }, answer: "which one?", done: false, waitingForUser: true })
})
