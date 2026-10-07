import { Effect } from "effect"

// herdr (herdr.dev, a terminal workspace for agents) shows each pane's agent as idle, working or blocked.
// empty-vessel tells it directly. Inside a herdr pane these variables are set; outside one, every report is a no-op.
const { HERDR_ENV, HERDR_BIN_PATH: bin, HERDR_PANE_ID: pane } = process.env
const inHerdr = HERDR_ENV === "1" && !!bin && !!pane

// Each report is its own process, so they can land out of order: each carries a rising number and herdr drops
// stale ones. Starting from the clock keeps it rising across restarts in the same pane.
let seq = Date.now()

// Fire and forget: herdr being slow or missing never holds up (or breaks) a turn.
const send = (verb: string, extra: ReadonlyArray<string> = []) =>
  Effect.sync(() => {
    if (!inHerdr) return
    const args = [bin!, "pane", verb, pane!, "--source", "custom:empty-vessel", "--agent", "empty-vessel", "--seq", String(++seq), ...extra]
    try { Bun.spawn(args, { stdout: "ignore", stderr: "ignore" }) } catch {}
  })

export const reportState = (state: "idle" | "working", extra: ReadonlyArray<string> = []) => send("report-agent", ["--state", state, ...extra])
export const releaseAgent = send("release-agent")
