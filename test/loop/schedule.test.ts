import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ALL, allows, NEEDS } from "../../src/base/grants"
import { makeHost } from "../../src/loop/kernel"
import { type TimerService, Timers } from "../../src/loop/jobs"
import { builtinsModule } from "../../src/loop/library"
import { type Ctx, newConversation } from "../../src/loop/turnkit"
import { kernelInstructions } from "../../src/system-two/instructions"
import { effectful } from "../../src/tools/kernel-service"

// schedule() and the timers jobs() and cancel() show: the host side, with the agent's timers faked (or absent).
const ctx = () => ({ conversation: newConversation(), session: { record: () => Effect.void } }) as unknown as Ctx
const host = (timers?: TimerService) => {
  const services = Effect.runSync(Effect.context<never>().pipe(timers ? Effect.provideService(Timers, timers) : (e) => e))
  const h = makeHost(ctx(), services as never)
  return (name: string, arg?: unknown): Promise<unknown> => Effect.runPromise(h[name]!(arg))
}
const fake = (origin?: string) => {
  const calls: Array<[string, unknown]> = []
  const timers: TimerService = {
    origin: () => origin,
    schedule: (args) => Effect.sync(() => { calls.push(["schedule", args]); return "timer-1" }),
    detach: () => Effect.fail(new Error("unused")),
    list: Effect.succeed({ "timer-1": { task: "stretch", status: "at 2026-10-23T09:00:00.000Z, by the model" } }),
    cancel: (id) => Effect.sync(() => { calls.push(["cancel", id]); return `${id} cancelled` }),
  }
  return { calls, timers }
}

test("schedule without the background agent fails with a reason; jobs() shows no timers", async () => {
  const call = host()
  await expect(call("schedule", { at: "2026-10-23T09:00:00Z", prompt: "stretch" })).rejects.toThrow("needs the background agent")
  await expect(call("cancel", "timer-1")).rejects.toThrow("needs the background agent")
  expect(await call("jobs")).toEqual({})
})

test("schedule goes to the agent's timers; jobs() lists them beside sub-agents and cancel(timer id) removes one", async () => {
  const { calls, timers } = fake("user")
  const call = host(timers)
  expect(await call("schedule", { cron: "0 9 * * *", tz: "Europe/London", prompt: "the morning briefing" })).toBe("timer-1")
  expect(await call("jobs")).toEqual({ "timer-1": { task: "stretch", status: "at 2026-10-23T09:00:00.000Z, by the model" } })
  expect(await call("cancel", "timer-1")).toBe("timer-1 cancelled")
  expect(await call("cancel", "job-9")).toBe("no job job-9") // a sub-agent id stays with the sub-agents
  expect(calls).toEqual([["schedule", { cron: "0 9 * * *", tz: "Europe/London", prompt: "the morning briefing" }], ["cancel", "timer-1"]])
})

test("a run whose lineage began in a job or a detached sub-agent can't schedule (R17)", async () => {
  for (const origin of ["cron", "subagent"]) {
    const { calls, timers } = fake(origin)
    await expect(host(timers)("schedule", { at: "2026-10-23T09:00:00Z", prompt: "again" })).rejects.toThrow("can't schedule")
    expect(calls).toEqual([])
  }
})

test("schedule is an effectful agents built-in, described to System Two", () => {
  expect(NEEDS.schedule).toBe("agents")
  expect(effectful("schedule")).toBe(true)
  expect(allows({ ...ALL, agents: false }, "schedule")).toBe(false)
  expect(builtinsModule([], ALL)).toContain("schedule")
  expect(kernelInstructions(ALL)).toContain("schedule({")
  expect(kernelInstructions({ ...ALL, agents: false })).not.toContain("schedule({")
})
