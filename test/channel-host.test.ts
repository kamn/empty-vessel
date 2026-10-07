import { expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Queue } from "effect"
import { serveChannel } from "../src/channel-host"
import { interactionOperations, makeSessionRunner } from "../src/interaction"
import { SessionError, type SessionHandle } from "../src/base/session"
import { newConversation } from "../src/loop/turnkit"
import { AskUser } from "../src/ui/ask"
import { Inbox } from "../src/base/inbox"
import { emit } from "../src/base/events"
import { afterCommand, newCallState, showActivity } from "../src/system-two/dispatch"

const result = { reply: "ok", remembered: [], usage: [], brief: { turn: "usage", session: "total" } }
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(effect.pipe(
  Effect.scoped, Effect.provideContext(Context.empty() as Context.Context<Exclude<R, never>>),
  Effect.timeout("3 seconds"),
))
const harness = (overrides: Partial<typeof interactionOperations> = {}, failSend?: (text: string) => boolean, retrySend = false, liveProgress = false) => Effect.gen(function* () {
  const input = yield* Queue.unbounded<string>()
  const output = yield* Queue.unbounded<string>()
  const sent: string[] = []
  const progress: string[] = []
  const conversation = newConversation()
  let listenerClosed = false
  const channel = {
    ...(liveProgress ? { progress: (text: string) => Effect.sync(() => { progress.push(text) }) } : {}),
    loadSession: Effect.succeed(undefined), saveSession: () => Effect.void,
    send: (text: string) => Effect.sync(() => { sent.push(text) }).pipe(Effect.flatMap(() =>
      failSend?.(text) ? Effect.fail(new Error("sender failed")) : Queue.offer(output, text).pipe(Effect.asVoid)), Effect.retry({ times: retrySend ? 2 : 0 })),
    listen: (receive: (text: string) => Effect.Effect<void>) => Effect.forever(Queue.take(input).pipe(
      Effect.flatMap((text) => text === "FAIL_LISTENER" ? Effect.fail(new Error("listener failed")) : receive(text)),
    )).pipe(Effect.ensuring(Effect.sync(() => { listenerClosed = true }))),
  }
  const operations = { ...interactionOperations, answer: () => Effect.succeed(result),
    stopped: () => Effect.succeed("(stopped)"), ...overrides }
  const fiber = yield* Effect.forkChild(Effect.scoped(serveChannel(channel, "test-session", (adapters) =>
    makeSessionRunner({} as SessionHandle, conversation, adapters, operations))))
  const send = (text: string) => Queue.offer(input, text)
  const until = (match: string): Effect.Effect<string> => Queue.take(output).pipe(
    Effect.flatMap((text) => text.includes(match) ? Effect.succeed(text) : until(match)),
  )
  const barrier = send("/status").pipe(Effect.andThen(until("Session test-session")))
  const exit = send("/exit").pipe(Effect.andThen(Fiber.join(fiber)))

  return { send, until, barrier, exit, fiber, sent, progress, conversation, listenerClosed: () => listenerClosed }
})

for (const [input, answer] of [["2", "blue"], ["my own answer", "my own answer"], ["3", "3"]]) {
  test(`question routes ${input} to ${answer}`, () => run(Effect.gen(function* () {
    const h = yield* harness({ answer: () => Effect.gen(function* () {
      const ask = yield* AskUser
      const replies = yield* ask.ask([{ question: "Colour?", options: ["red", "blue"] }])
      expect(replies[0]?.answer).toBe(answer)
      return result
    }) })
    yield* h.send("ask")
    expect(yield* h.until("Colour?")).toContain("2. blue")
    yield* h.send(input!)
    yield* h.until("usage")
    expect(yield* h.until("total")).toBe("total")
    expect(h.conversation.history).toEqual([{ user: "ask", answer: "ok" }])
    yield* h.exit
  })))
}

test("steering is consumed during work; only leftovers start another turn", () => run(Effect.gen(function* () {
  const read = yield* Deferred.make<void>()
  const consumed = yield* Deferred.make<void>()
  const finish = yield* Deferred.make<void>()
  const turns: string[] = []
  const h = yield* harness({ answer: (_, text) => Effect.gen(function* () {
    turns.push(text)
    if (text === "first") {
      yield* Deferred.await(read)
      expect((yield* Inbox).take()).toEqual(["steer now"])
      yield* Deferred.succeed(consumed, undefined)
      yield* Deferred.await(finish)
    }
    return { ...result, reply: `reply:${text}` }
  }) })
  yield* h.send("first")
  yield* h.until("Working")
  yield* h.send("steer now")
  yield* h.barrier
  yield* Deferred.succeed(read, undefined)
  yield* Deferred.await(consumed)
  yield* h.send("leftover")
  yield* h.barrier
  yield* Deferred.succeed(finish, undefined)
  yield* h.until("reply:leftover")
  expect(turns).toEqual(["first", "leftover"])
  yield* h.exit
})))

test("model, refine and shared/private shell commands serialize behind a turn", () => run(Effect.gen(function* () {
  const finish = yield* Deferred.make<void>()
  const calls: string[] = []
  const h = yield* harness({
    answer: () => Deferred.await(finish).pipe(Effect.tap(() => Effect.sync(() => { calls.push("turn") })), Effect.as(result)),
    modelCommand: (_s, _c, name, services) => Effect.sync(() => { calls.push(`model:${name}`); return { reply: "model", services } }),
    refineCommand: (text) => Effect.sync(() => { calls.push(`refine:${text.trim()}`); return "refined" }),
    userCommand: (_s, _c, cmd, share) => Effect.sync(() => { calls.push(`shell:${cmd}:${share}`); return `shell:${cmd}` }),
  })
  yield* h.send("work")
  yield* h.until("Working")
  for (const text of ["/model test", "/refine notes", "!echo shared", "!!echo private"]) yield* h.send(text)
  yield* h.barrier
  expect(calls).toEqual([])
  yield* Deferred.succeed(finish, undefined)
  yield* h.until("shell:echo private")
  expect(calls).toEqual(["turn", "model:test", "refine:notes", "shell:echo shared:true", "shell:echo private:false"])
  yield* h.exit
})))

test("stop clears queued commands and pending question, allowing the next question", () => run(Effect.gen(function* () {
  let cleaned = 0
  let stopped = 0
  const h = yield* harness({
    answer: (_s, text) => Effect.gen(function* () {
      if (text === "first") yield* Effect.never.pipe(Effect.ensuring(Effect.sync(() => { cleaned++ })))
      const replies = yield* (yield* AskUser).ask([{ question: `Question:${text}`, options: ["yes"] }])
      return { ...result, reply: replies[0]!.answer }
    }),
    stopped: () => Effect.sync(() => { stopped++; return "(stopped)" }),
    userCommand: () => Effect.die("queued shell must be discarded"),
  })
  yield* h.send("first")
  yield* h.until("Working")
  yield* h.send("!must-not-run")
  yield* h.send("discard this steering")
  yield* h.send("/stop")
  yield* h.until("(stopped)")
  yield* h.send("second")
  yield* h.until("Question:second")
  yield* h.send("/stop")
  yield* h.until("(stopped)")
  yield* h.send("third")
  yield* h.until("Question:third")
  yield* h.send("1")
  yield* h.until("usage")
  expect([cleaned, stopped]).toEqual([1, 2])
  expect(h.conversation.history.map((turn) => turn.user)).toEqual(["first", "second", "third"])
  yield* h.exit
})))

for (const mode of ["sender", "listener", "exit"] as const) {
  test(`${mode} interrupts active work and closes listener without rerunning`, () => run(Effect.gen(function* () {
    let calls = 0
    let cleaned = 0
    let stopped = 0
    const h = yield* harness({
      answer: () => Effect.gen(function* () {
        calls++
        yield* (yield* AskUser).ask([{ question: "Blocked question", options: ["yes"] }])
        return result
      }).pipe(Effect.ensuring(Effect.sync(() => { cleaned++ }))),
      stopped: () => Effect.sync(() => { stopped++; return "(stopped)" }),
    }, (text) => mode === "sender" && text.includes("Blocked question"))
    yield* h.send("work")
    if (mode !== "sender") {
      yield* h.until("Blocked question")
      yield* h.send(mode === "listener" ? "FAIL_LISTENER" : "/exit")
    }
    const exit = yield* Fiber.await(h.fiber)
    expect(Exit.isSuccess(exit)).toBe(mode === "exit")
    expect([calls, cleaned, stopped]).toEqual([1, 1, 1])
    expect(h.listenerClosed()).toBe(true)
    if (mode === "exit") expect(h.sent.at(-1)).toContain("will resume")
  })))
}

test("failed work is reported once and a later explicit turn still runs", () => run(Effect.gen(function* () {
  const calls: string[] = []
  const h = yield* harness({ answer: (_s, text) => Effect.suspend(() => {
    calls.push(text)
    return text === "fail" ? Effect.fail(new SessionError({ cause: "operation failed after doing work" })) : Effect.succeed(result)
  }) })
  yield* h.send("fail")
  yield* h.until("it was not rerun")
  yield* h.barrier
  expect(calls).toEqual(["fail"])
  yield* h.send("next")
  yield* h.until("usage")
  expect(calls).toEqual(["fail", "next"])
  yield* h.exit
})))

test("transport delivery retries never repeat completed session work", () => run(Effect.gen(function* () {
  let calls = 0
  let deliveries = 0
  const h = yield* harness({ answer: () => Effect.sync(() => { calls++; return result }) },
    (text) => text === "ok" && ++deliveries < 3, true)
  yield* h.send("work")
  yield* h.until("usage")
  expect(calls).toBe(1)
  expect(deliveries).toBe(3)
  expect(h.conversation.history).toEqual([{ user: "work", answer: "ok" }])
  yield* h.exit
})))

test("cell summaries update progress while notes, questions and replies stay permanent", () => run(Effect.gen(function* () {
  const h = yield* harness({ answer: () => Effect.gen(function* () {
    const cell = { summary: "Inspect project", code: "SECRET CODE" }
    yield* showActivity("kernel", cell, {})
    yield* afterCommand("kernel", cell, "SECRET OUTPUT", {}, newCallState())
    yield* emit("activity", 0, "Thinking")
    yield* emit("note", 0, "User update")
    yield* (yield* AskUser).ask([{ question: "Continue?", options: ["yes"] }])
    yield* emit("system-two", 0, "raw title", "SECRET BODY", "Apply change")
    return result
  }) }, undefined, false, true)
  yield* h.send("work")
  yield* h.until("Continue?")
  yield* h.send("1")
  yield* h.until("total")

  expect(h.progress).toEqual(["Working…", "Inspect project", "Inspect project", "Apply change"])
  expect(h.sent).toEqual(["User update", expect.stringContaining("Continue?"), "ok", "usage", "total"])
  expect([...h.sent, ...h.progress].join("\n")).not.toContain("SECRET")
  yield* h.exit
})))
