import { Effect } from "effect"

// One source per process: Herdr retains each source's sequence high-water mark after release.
// A new launch must not depend on the wall clock overtaking the previous launch's reports.
const { HERDR_ENV, HERDR_BIN_PATH: bin, HERDR_PANE_ID: pane } = process.env
const inHerdr = HERDR_ENV === "1" && !!bin && !!pane
const source = `custom:empty-vessel:${crypto.randomUUID()}`
let seq = 0
let tail: Promise<void> = Promise.resolve()
let warned = false
const warn = (reason: unknown) => {
  if (warned) return
  warned = true
  console.error(`[herdr] Could not deliver agent state: ${String(reason)}`)
}

// Await and serialize child completion, including release on shutdown. Otherwise a delayed
// report can resurrect an old owner after release. Bound failures so Herdr cannot hang a turn.
const deliver = async (args: string[]) => {
  let child: ReturnType<typeof Bun.spawn> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    child = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" })
    const code = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try { child?.kill("SIGKILL") } catch {}
          reject(new Error("report timed out after 3000ms"))
        }, 3000)
      }),
    ])
    if (code !== 0) warn(`report exited with code ${code}`)
  } catch (cause) { warn(cause) }
  finally { if (timer) clearTimeout(timer) }
}
const send = (verb: string, extra: ReadonlyArray<string> = []) =>
  Effect.uninterruptible(Effect.promise(() => {
    if (!inHerdr) return Promise.resolve()
    const args = [bin!, "pane", verb, pane!, "--source", source, "--agent", "empty-vessel", "--seq", String(++seq), ...extra]
    const next = tail.then(() => deliver(args))
    tail = next
    return next
  }))

type State = "idle" | "working" | "blocked"
let current: State = "idle"
export const reportState = (state: State, extra: ReadonlyArray<string> = []) => Effect.gen(function* () {
  current = state
  yield* send("report-agent", ["--state", state, ...extra])
})

// Herdr calls its user-attention state blocked (the UI may label it Asking).
export const withAsking = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const previous = current
    return Effect.gen(function* () {
      yield* reportState("blocked")
      return yield* effect
    }).pipe(Effect.ensuring(reportState(previous)))
  })

// wait_for_user ends a successful turn without ending the need for user input.
export const finishTurn = Effect.suspend(() => current === "blocked" ? Effect.void : reportState("idle"))
export const releaseAgent = send("release-agent")
