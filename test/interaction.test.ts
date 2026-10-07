import { expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber } from "effect"
import { interactionOperations, makeSessionRunner } from "../src/interaction"
import type { SessionHandle } from "../src/base/session"
import { newConversation } from "../src/loop/turnkit"
import { AskUser } from "../src/ui/ask"
import { Inbox } from "../src/base/inbox"
import { Kernel } from "../src/tools/kernel-service"

const session = {} as SessionHandle
const result = { reply: "ok", remembered: [], usage: [], brief: { turn: "turn", session: "total" } }
const events = { emit: () => Effect.void }
const ops = (overrides: Partial<typeof interactionOperations> = {}) => ({
  ...interactionOperations,
  answer: () => Effect.succeed(result),
  stopped: () => Effect.succeed("(stopped)"),
  ...overrides,
})
// Fake operations never access production services; the empty context discharges their declared requirements.
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provideContext(Context.empty() as Context.Context<Exclude<R, never>>)))

test("records turns and usage; commands don't append conversation history", () => run(Effect.gen(function* () {
  const conversation = newConversation()
  const runner = yield* makeSessionRunner(session, conversation, { events }, ops({ refineCommand: () => Effect.succeed("refined") }))
  expect(yield* runner.run("hello")).toEqual({ reply: "ok", usage: ["turn"], total: "total" })
  expect(yield* runner.run("/refine log")).toEqual({ reply: "refined", usage: [] })
  expect(conversation.history).toEqual([{ user: "hello", answer: "ok" }])
})))

test("rejects overlap, stops a turn, and keeps ownership through cleanup", () => run(Effect.gen(function* () {
  const started = yield* Deferred.make<void>()
  const cleaning = yield* Deferred.make<void>()
  const finish = yield* Deferred.make<void>()
  const conversation = newConversation()
  const runner = yield* makeSessionRunner(session, conversation, { events }, ops({
    answer: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
    stopped: () => Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(finish)), Effect.as("(stopped)")),
  }))
  const first = yield* Effect.forkChild(runner.run("first"))
  yield* Deferred.await(started)
  expect(Exit.isFailure(yield* Effect.exit(runner.run("overlap")))).toBe(true)
  const stop = yield* Effect.forkChild(runner.stop)
  yield* Deferred.await(cleaning)
  expect(Exit.isFailure(yield* Effect.exit(runner.shell("echo nope", false)))).toBe(true)
  yield* Deferred.succeed(finish, undefined)
  yield* Fiber.join(stop)
  expect((yield* Fiber.join(first)).reply).toBe("(stopped)")
  expect(conversation.history).toEqual([{ user: "first", answer: "(stopped)" }])
})))

for (const kind of ["refine", "shell", "model"] as const) {
  test(`${kind} is stoppable and releases ownership`, () => run(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const blocked = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
    const runner = yield* makeSessionRunner(session, newConversation(), { events }, ops({
      refineCommand: () => blocked, userCommand: () => blocked, modelCommand: () => blocked,
    }))
    const fiber = yield* Effect.forkChild(kind === "shell" ? runner.shell("sleep 100", true) : runner.run(`/${kind}`))
    yield* Deferred.await(started)
    yield* runner.stop
    const value = yield* Fiber.join(fiber)
    expect(typeof value === "string" ? value : value.reply).toBe("(stopped)")
    expect((yield* runner.run("next")).reply).toBe("ok")
  })))
}

test("questions preserve notes; consumed steering notifies, drain does not", () => run(Effect.gen(function* () {
  const asked = yield* Deferred.make<void>()
  const reads: string[] = []
  const runner = yield* makeSessionRunner(session, newConversation(), {
    events, onSteerRead: text => reads.push(text),
    presentQuestion: () => Deferred.succeed(asked, undefined).pipe(Effect.asVoid),
  }, ops({ answer: () => Effect.gen(function* () {
    const replies = yield* (yield* AskUser).ask([{ question: "Choose", options: ["yes"] }])
    expect(replies).toEqual([{ question: "Choose", answer: "yes", note: "note" }])
    expect((yield* Inbox).take()).toEqual(["steering"])
    return result
  }) }))
  const fiber = yield* Effect.forkChild(runner.run("question"))
  yield* Deferred.await(asked)
  yield* runner.steer("steering")
  yield* runner.answer({ answer: "yes", note: "note" })
  yield* Fiber.join(fiber)
  yield* runner.steer("leftover")
  expect(yield* runner.drain).toEqual(["leftover"])
  expect(reads).toEqual(["steering"])
  yield* runner.answer({ answer: "late reply ignored" })
})))

test("external interruption tidies history and allows the next interaction", () => run(Effect.gen(function* () {
  const started = yield* Deferred.make<void>()
  const conversation = newConversation()
  let count = 0
  const runner = yield* makeSessionRunner(session, conversation, { events }, ops({
    answer: () => ++count === 1 ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)) : Effect.succeed(result),
  }))
  const fiber = yield* Effect.forkChild(runner.run("interrupted"))
  yield* Deferred.await(started)
  yield* Fiber.interrupt(fiber)
  expect((yield* runner.run("next")).reply).toBe("ok")
  expect(conversation.history.map(x => x.answer)).toEqual(["(stopped)", "ok"])
})))

test("model switching has a distinct owner for each session", () => run(Effect.gen(function* () {
  const owners: unknown[] = []
  const operations = ops({ modelCommand: (_session, _conversation, name, services, owner) => {
    owners.push(owner)
    return Effect.succeed({ reply: name, services })
  } })
  const a = yield* makeSessionRunner(session, newConversation(), { events }, operations)
  const b = yield* makeSessionRunner(session, newConversation(), { events }, operations)
  yield* a.run("/model first")
  yield* b.run("/model second")
  yield* a.run("/model third")
  expect(owners[0]).toBe(owners[2])
  expect(owners[0]).not.toBe(owners[1])
})))

test("failure clears ownership without recording a successful turn", () => run(Effect.gen(function* () {
  const conversation = newConversation()
  let calls = 0
  const runner = yield* makeSessionRunner(session, conversation, { events }, ops({
    answer: () => ++calls === 1 ? Effect.die("broken") : Effect.succeed(result),
  }))
  expect(Exit.isFailure(yield* Effect.exit(runner.run("failed")))).toBe(true)
  expect(conversation.history).toEqual([])
  expect((yield* runner.run("retry")).reply).toBe("ok")
})))

test("stopping a question clears it before the next question", () => run(Effect.gen(function* () {
  let shown = yield* Deferred.make<void>()
  const runner = yield* makeSessionRunner(session, newConversation(), {
    events, presentQuestion: () => Deferred.succeed(shown, undefined).pipe(Effect.asVoid),
  }, ops({ answer: () => Effect.gen(function* () {
    const replies = yield* (yield* AskUser).ask([{ question: "Choose", options: ["yes"] }])
    return { ...result, reply: replies[0]!.answer }
  }) }))
  const first = yield* Effect.forkChild(runner.run("one"))
  yield* Deferred.await(shown)
  yield* runner.stop
  yield* Fiber.join(first)
  yield* runner.answer({ answer: "stale" })
  shown = yield* Deferred.make<void>()
  const next = yield* Effect.forkChild(runner.run("two"))
  yield* Deferred.await(shown)
  yield* runner.answer({ answer: "fresh" })
  expect((yield* Fiber.join(next)).reply).toBe("fresh")
})))

test("shell uses captured session services and shares only single-bang output", () => run(Effect.gen(function* () {
  const conversation = newConversation()
  const records: string[] = []
  const recording: SessionHandle = {
    id: "test", key: "sessions/test", dir: "/unused",
    record: (kind, text) => Effect.sync(() => { records.push(`${kind}:${text}`) }),
  }
  const runner = yield* makeSessionRunner(recording, conversation, { events }, ops()).pipe(
    Effect.provideService(Kernel, { ...Kernel.defaultValue(), exec: command => Effect.succeed(`output:${command}`) }),
  )
  expect(yield* runner.shell("shared", true)).toBe("output:shared")
  expect(yield* runner.shell("private", false)).toBe("output:private")
  expect(conversation.history).toEqual([{ user: "! shared", answer: "output:shared" }])
  expect(conversation.unseen).toEqual(conversation.history)
  expect(records).toEqual(["user:! shared", "assistant:output:shared"])
})))

const Selected = Context.Reference<string>("test/interaction-selected", { defaultValue: () => "initial" })
test("model services persist for subsequent turns without changing another session", () => run(Effect.gen(function* () {
  const operations = ops({
    answer: () => Effect.gen(function* () { return { ...result, reply: yield* Selected } }),
    modelCommand: (_session, _conversation, name, services) => Effect.succeed({ reply: name, services: Context.add(services, Selected, name) }),
  })
  const a = yield* makeSessionRunner(session, newConversation(), { events }, operations)
  const b = yield* makeSessionRunner(session, newConversation(), { events }, operations)
  yield* a.run("/model changed")
  expect((yield* a.run("one")).reply).toBe("changed")
  expect((yield* b.run("two")).reply).toBe("initial")
})))
