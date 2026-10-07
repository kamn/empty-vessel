import { Cause, Effect, Fiber, Semaphore } from "effect"

// Sub-agents as jobs: spawn starts one and returns its id at once; it runs in the host (not in
// the cell, whose Worker ends with the cell), at most AT_ONCE at a time, the rest queued. System Two collects answers
// with wait, or drops jobs with cancel. A System Two run can't finish with jobs it hasn't collected (see pending).

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled"
type Job = { readonly id: string; readonly task: string; status: JobStatus; answer?: string; collected: boolean; fiber?: Fiber.Fiber<void, never> }
export type JobView = { readonly status: JobStatus; readonly answer?: string }

const AT_ONCE = 4 // sub-agents running at the same time; ponytail: fixed; a total budget per turn is still open

export const makeJobs = () => {
  const all = new Map<string, Job>()
  const slots = Semaphore.makeUnsafe(AT_ONCE)
  let next = 0

  const view = (j: Job): JobView => ({ status: j.status, ...(j.answer !== undefined ? { answer: j.answer } : {}) })

  // Start a job: `run` is the sub-agent's whole turn. Returns the id straight away.
  const spawn = (task: string, run: Effect.Effect<string, unknown>) =>
    Effect.sync(() => {
      const job: Job = { id: `job-${++next}`, task, status: "queued", collected: false }
      all.set(job.id, job)
      job.fiber = Effect.runFork(slots.withPermit(
        Effect.sync(() => { job.status = "running" }).pipe(
          Effect.andThen(run),
          // matchCause, not match: a crash (a defect) is a failure too; match left such a job "running" forever.
          // An interruption from inside the run counts as cancelled, like one from cancel.
          Effect.matchCause({
            onSuccess: (answer) => { job.status = "done"; job.answer = answer },
            onFailure: (cause) => {
              if (Cause.hasInterruptsOnly(cause)) { job.status = "cancelled"; return }
              job.status = "failed"
              job.answer = Cause.hasFails(cause) ? String(Cause.squash(cause)) : Cause.pretty(cause)
            },
          }),
        ),
      ).pipe(Effect.onInterrupt(() => Effect.sync(() => { job.status = "cancelled" }))))
      return job.id
    })

  // Wait up to `seconds` for these jobs; each comes back done (with its answer), failed, cancelled, or still running.
  // Finished ones count as collected. A wait that's stopped (its cell ended) only stops waiting: the jobs go on.
  const wait = (ids: ReadonlyArray<string>, seconds: number) =>
    Effect.gen(function* () {
      const known = ids.filter((id) => all.has(id))
      const fibers = known.map((id) => all.get(id)!.fiber!)
      yield* Effect.forEach(fibers, (f) => Fiber.await(f), { concurrency: "unbounded", discard: true }).pipe(Effect.timeoutOption(`${seconds} seconds`))

      return Object.fromEntries(ids.map((id): [string, JobView | { status: "unknown" }] => {
        const job = all.get(id)
        if (!job) return [id, { status: "unknown" }]
        if (job.status === "done" || job.status === "failed" || job.status === "cancelled") job.collected = true
        return [id, view(job)]
      }))
    })

  const cancel = (id: string) =>
    Effect.gen(function* () {
      const job = all.get(id)
      if (!job?.fiber) return `no job ${id}`
      job.collected = true
      yield* Fiber.interrupt(job.fiber)
      return `${id} cancelled`
    })

  const list = () => Object.fromEntries([...all.values()].map((j) => [j.id, { task: j.task.slice(0, 120), status: j.status }]))

  // Jobs System Two hasn't collected yet (running, queued, or finished but not waited for).
  const pending = () => [...all.values()].filter((j) => !j.collected).map((j) => `${j.id} (${j.status}): ${j.task.slice(0, 100)}`)

  // Stop everything (Ctrl+C, or the owner's turn ending): no job outlives the agent that started it.
  // Cancelled jobs count as collected: nobody should be reminded about them afterwards.
  const cancelAll = Effect.suspend(() =>
    Effect.forEach([...all.values()].filter((j) => j.fiber), (j) => { j.collected = true; return Fiber.interrupt(j.fiber!) }, { discard: true }))

  return { spawn, wait, cancel, list, pending, cancelAll }
}

export type Jobs = ReturnType<typeof makeJobs>
