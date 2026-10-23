import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { ConfigSchema } from "../../src/base/config"
import { makeHost } from "../../src/loop/kernel"
import { type TimerService, Timers } from "../../src/loop/jobs"
import { newConversation } from "../../src/loop/turnkit"
import { systemEntry } from "../../src/loop/turn"

// spawn(task, { detach: true }): the host side, with the agent's timers faked (or absent, as in the plain TUI).
const config = Schema.decodeUnknownSync(ConfigSchema)({})
const setup = (timers?: TimerService, depth = 0) => {
  const conversation = newConversation()
  const ctx = { depth, config, conversation, session: { record: () => Effect.void }, spawn: (task: string) => Effect.never.pipe(Effect.as(task)) }
  const services = Effect.runSync(Effect.context<never>().pipe(timers ? Effect.provideService(Timers, timers) : (e) => e))
  const h = makeHost(ctx as never, services as never)
  const call = (name: string, arg?: unknown): Promise<unknown> => Effect.runPromise(h[name]!(arg) as Effect.Effect<unknown, unknown>)
  const refused = (name: string, arg?: unknown) => Effect.runPromise(Effect.flip(h[name]!(arg) as Effect.Effect<unknown, unknown>)).then(String)
  return { conversation, call, refused }
}
const fake = (origin?: string) => {
  const calls: Array<[string, unknown]> = []
  const timers: TimerService = {
    origin: () => origin,
    schedule: () => Effect.succeed("timer-1"),
    detach: (task) => Effect.sync(() => { calls.push(["detach", task]); return "detached-1" }),
    list: Effect.succeed({ "detached-1": { task: "review the diff", status: "running" } }),
    cancel: (id) => Effect.sync(() => { calls.push(["cancel", id]); return `${id} cancelled` }),
  }
  return { calls, timers }
}

test("a detached spawn without the background agent fails with a reason and starts nothing", async () => {
  const { conversation, refused } = setup()
  expect(await refused("spawn", { task: "review the diff", detach: true })).toContain("needs the background agent")
  expect(conversation.jobs.list()).toEqual({})
})

test("a detached spawn goes to the agent: not one of this turn's jobs, so the pending-jobs reminder ignores it; jobs() and cancel reach it", async () => {
  const { calls, timers } = fake("user")
  const { conversation, call } = setup(timers)
  expect(await call("spawn", { task: "review the diff", detach: true })).toBe("detached-1")
  expect(conversation.jobs.list()).toEqual({})
  expect(conversation.jobs.pending()).toEqual([])
  expect(await call("jobs")).toEqual({ "detached-1": { task: "review the diff", status: "running" } })
  expect(await call("cancel", "detached-1")).toBe("detached-1 cancelled")
  expect(calls).toEqual([["detach", "review the diff"], ["cancel", "detached-1"]])
})

test("a plain spawn is unchanged: one of this turn's jobs, cancelled when the turn ends", async () => {
  const { calls, timers } = fake("user")
  const { conversation, call } = setup(timers)
  const id = await call("spawn", { task: "count the files" }) as string
  expect(conversation.jobs.pending()).toHaveLength(1)
  await Effect.runPromise(conversation.jobs.cancelAll)
  expect(conversation.jobs.list()[id]?.status).toBe("cancelled")
  expect(calls).toEqual([])
})

test("a detached spawn is refused in a run a job or a detached sub-agent started, in a sub-agent, and with tools or an agent", async () => {
  for (const origin of ["cron", "subagent"]) {
    const { calls, timers } = fake(origin)
    expect(await setup(timers).refused("spawn", { task: "again", detach: true })).toContain("can't start a detached sub-agent")
    expect(calls).toEqual([])
  }
  const { calls, timers } = fake("user")
  expect(await setup(timers, 1).refused("spawn", { task: "deeper", detach: true })).toContain("main agent")
  expect(await setup(timers).refused("spawn", { task: "narrow", detach: true, tools: { shell: false } })).toContain("main agent")
  expect(calls).toEqual([])
})

test("a message no user wrote reaches System Two as a system entry, marked with its origin; the user's own is as typed", () => {
  expect(systemEntry("job detached-1 finished: done", "subagent")).toBe("[System entry, not from the user (origin: subagent)]\njob detached-1 finished: done")
  expect(systemEntry("hello", "user")).toBe("hello")
  expect(systemEntry("hello", undefined)).toBe("hello")
})
