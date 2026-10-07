import { expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber, Schema } from "effect"
import { Delivery } from "../src/base/delivery"
import { Events } from "../src/base/events"
import { callTool, newCallState, SYSTEM_TWO_TOOLS } from "../src/system-two/dispatch"
import { TellUserArgs } from "../src/system-two/systemtwo"
import { interactionOperations, makeSessionRunner } from "../src/interaction"
import { serveChannel } from "../src/channel-host"
import type { SessionHandle } from "../src/base/session"
import { newConversation } from "../src/loop/turnkit"

const args = { message: "Report", file: "local/report.pdf" }
const call = (depth = 0) => callTool("tell_user", args, { depth }, newCallState())
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(effect.pipe(
  Effect.scoped, Effect.provideContext(Context.empty() as Context.Context<Exclude<R, never>>), Effect.timeout("3 seconds"),
))
test("tell_user accepts an optional nonempty local file path", () => {
  expect(Schema.decodeUnknownSync(TellUserArgs)({ message: "hello" })).toEqual({ message: "hello" })
  expect(Schema.decodeUnknownSync(TellUserArgs)(args)).toEqual(args)
  expect(() => Schema.decodeUnknownSync(TellUserArgs)({ ...args, file: "" })).toThrow()
  const schema = SYSTEM_TWO_TOOLS.find((tool) => tool.name === "tell_user")!.parameters
  expect(JSON.stringify(schema)).toContain("Local file path")
  expect((schema as { required?: string[] }).required).not.toContain("file")
})

test("attachment waits for acknowledgement, uses caption, and emits no duplicate note", () => run(Effect.gen(function* () {
  const started = yield* Deferred.make<void>()
  const finish = yield* Deferred.make<void>()
  const notes: string[] = []
  let completed = false
  const state = newCallState(new Map(), () => 123)
  state.told = 0
  const work = callTool("tell_user", args, {}, state).pipe(
    Effect.provideService(Delivery, { sendFile: (path, caption) => Effect.gen(function* () {
      expect([path, caption]).toEqual([args.file, args.message])
      yield* Deferred.succeed(started, undefined)
      yield* Deferred.await(finish)
    }) }),
    Effect.provideService(Events, { emit: (event) => Effect.sync(() => { notes.push(event.kind) }) }),
    Effect.tap(() => Effect.sync(() => { completed = true })),
  )
  const fiber = yield* Effect.forkChild(work)
  yield* Deferred.await(started)
  expect(completed).toBe(false)
  expect(state.told).toBe(0)
  yield* Deferred.succeed(finish, undefined)
  expect(yield* Fiber.join(fiber)).toEqual({ output: "The user has the file and caption. Keep working." })
  expect(state.told).toBe(123)
  expect(notes).not.toContain("note")
})))

test("disabled file access blocks attachments before delivery", () => run(Effect.gen(function* () {
  let deliveryCalls = 0
  const state = newCallState(new Map(), () => 123)
  state.told = 0
  const grants = { files: "none" as const, shell: false, systemOne: false, agents: false, library: false, sources: false }

  const result = yield* callTool("tell_user", args, { depth: 0, grants }, state).pipe(
    Effect.provideService(Delivery, {
      sendFile: () => {
        deliveryCalls++
        return Effect.void
      },
    }),
  )

  expect(result).toEqual({ output: "File attachments require file-read access." })
  expect(deliveryCalls).toBe(0)
  expect(state.told).toBe(0)
})))

test("unsupported and failed deliveries report errors without credentials or success", () => run(Effect.gen(function* () {
  expect(yield* call()).toEqual({ output: "File delivery failed: Local file attachments are not supported by this interaction." })
  const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456789"
  const state = newCallState(new Map(), () => 123)
  state.told = 0
  const result = yield* callTool("tell_user", args, {}, state).pipe(Effect.provideService(Delivery, {
    sendFile: () => Effect.fail(new Error(`Upload denied: https://api.telegram.org/bot${token}/sendDocument token ${token}`)),
  }))
  expect(result).toHaveProperty("output")
  expect(JSON.stringify(result)).toContain("Upload denied")
  expect(JSON.stringify(result)).not.toContain(token)
  expect(JSON.stringify(result)).not.toContain("The user has")
  expect(state.told).toBe(0)
})))

test("subagents cannot send attachments, but ordinary notes remain unchanged", () => run(Effect.gen(function* () {
  expect(yield* call(1).pipe(Effect.provideService(Delivery, {
    sendFile: () => Effect.die("must not send"),
  }))).toEqual({ output: "File attachments are only available to the main agent." })
  const notes: string[] = []
  const result = yield* callTool("tell_user", { message: "hello" }, {}, newCallState()).pipe(
    Effect.provideService(Events, { emit: (event) => Effect.sync(() => { if (event.kind === "note") notes.push(event.text) }) }),
  )
  expect(result).toEqual({ output: "The user has it. Keep working." })
  expect(notes).toEqual(["hello"])
})))

for (const mode of ["success", "failure", "unsupported"] as const) {
  test(`host and runner await ${mode} file delivery`, () => run(Effect.gen(function* () {
    const observed = yield* Deferred.make<string>()
    const sent: Array<[string, string | undefined]> = []
    const channel = {
      loadSession: Effect.succeed(undefined), saveSession: () => Effect.void, send: () => Effect.void,
      ...(mode === "unsupported" ? {} : { sendFile: (path: string, caption?: string) => {
        sent.push([path, caption])
        return mode === "failure" ? Effect.fail(new Error("permission denied")) : Effect.void
      } }),
      listen: (receive: (text: string) => Effect.Effect<void>) => receive("send report").pipe(Effect.andThen(Effect.never)),
    }
    const operations = { ...interactionOperations, answer: () => Effect.gen(function* () {
      const result = yield* call()
      yield* Deferred.succeed(observed, JSON.stringify(result))
      return { reply: "finished", remembered: [], usage: [], brief: { turn: "", session: "" } }
    }) }
    const fiber = yield* Effect.forkChild(serveChannel(channel, "files", (adapters) =>
      makeSessionRunner({} as SessionHandle, newConversation(), adapters, operations)))
    const output = yield* Deferred.await(observed)
    expect(output).toContain(mode === "success" ? "The user has the file" : mode === "failure" ? "permission denied" : "not supported")
    expect(sent).toEqual(mode === "unsupported" ? [] : [[args.file, args.message]])
    yield* Fiber.interrupt(fiber)
  })))
}
