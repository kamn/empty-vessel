import { expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import { makeJobs } from "../../src/loop/jobs"

const run = <A>(e: Effect.Effect<A, unknown>) => Effect.runPromise(e)
// A sub-agent we release by hand: its answer arrives when the test says so.
const heldAgent = () => {
  const done = Deferred.makeUnsafe<string>()
  return { turn: Deferred.await(done), finish: (answer: string) => Effect.runSync(Deferred.succeed(done, answer)) }
}

test("spawn returns an id at once; wait reports running, then the answer; collected jobs aren't pending", async () => {
  const jobs = makeJobs()
  const agent = heldAgent()
  const id = await run(jobs.spawn("fix the parser", agent.turn))
  expect(id).toBe("job-1")

  expect(await run(jobs.wait([id], 0.1))).toEqual({ "job-1": { status: "running" } }) // still going: wait again later
  expect(jobs.pending()).toEqual(["job-1 (running): fix the parser"])

  agent.finish("parser fixed")
  expect(await run(jobs.wait([id], 5))).toEqual({ "job-1": { status: "done", answer: "parser fixed" } })
  expect(jobs.pending()).toEqual([])
})

test("at most 4 run at once, the rest queue; cancel and cancelAll stop them", async () => {
  const jobs = makeJobs()
  const agents = Array.from({ length: 5 }, heldAgent)
  const ids = await Promise.all(agents.map((a, i) => run(jobs.spawn(`task ${i}`, a.turn))))
  await Bun.sleep(20)
  expect(Object.values(jobs.list()).map((j) => j.status)).toEqual(["running", "running", "running", "running", "queued"])

  await run(jobs.cancel(ids[0]!))
  await Bun.sleep(20)
  expect(jobs.list()["job-1"]!.status).toBe("cancelled")
  expect(jobs.list()["job-5"]!.status).toBe("running") // a slot freed up

  await run(jobs.cancelAll)
  await Bun.sleep(20)
  expect(Object.values(jobs.list()).every((j) => j.status === "cancelled")).toBe(true)
  expect(jobs.pending()).toEqual([]) // stopped jobs aren't "uncollected": no reminders about them
})

test("a failed sub-agent is reported as failed, with the error as its answer", async () => {
  const jobs = makeJobs()
  const id = await run(jobs.spawn("doomed", Effect.fail("no network")))
  expect(await run(jobs.wait([id, "job-9"], 5))).toEqual({ "job-1": { status: "failed", answer: "no network" }, "job-9": { status: "unknown" } })
})

test("a sub-agent that crashes (a defect, not a failure) is reported as failed, not left running forever", async () => {
  const jobs = makeJobs()
  const id = await run(jobs.spawn("crashes", Effect.sync(() => JSON.parse("{ not json")) as Effect.Effect<string>))
  const got = (await run(jobs.wait([id], 5)))[id] as { status: string; answer?: string }
  expect(got.status).toBe("failed")
  expect(got.answer).toContain("SyntaxError")
  expect(jobs.pending()).toEqual([])
})
