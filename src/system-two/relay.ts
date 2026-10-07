import { randomUUIDv7 } from "bun"
import { rmSync } from "node:fs"
import { Cause, Context, Effect, Fiber, Semaphore } from "effect"
import { type CallState, callTool, type Ended, newCallState } from "./dispatch"
import { allGranted } from "../base/grants"
import type { Hooks } from "./systemtwo"
import { flush, newWire, receive, send, type Wire } from "./wire"

// System Two's tools for an agent CLI that runs its own loop (Claude Code today; any that speaks MCP): the CLI starts
// the MCP server in relay-server.ts, which sends each call back over a socket, and empty-vessel answers it here with the same
// hooks and the same callTool any backend's calls get. A plugin for such a CLI only starts it with `mcpConfig` and reads
// its output.

const SERVER = new URL("./relay-server.ts", import.meta.url).pathname
// What the CLI is told when a tool call ended its run (a finishing check, or waiting for the user).
const STOP = "This ends your turn: reply with one short line and no more tool calls."

// One run's state: how it ended (if a tool call ended it), whether System One still shortens long output, and a lock so
// its calls are answered one at a time: a CLI can make several at once, and two cells at once would both take the same
// cell number in the kernel. `calls`: the calls still being answered, so the run can stop them when it ends.
export type Run = CallState & { ended?: Ended; lock: Semaphore.Semaphore; calls: Set<Fiber.Fiber<void>> }
export const newRun = (stash: Map<string, string> = new Map()): Run => ({ ...newCallState(stash), lock: Semaphore.makeUnsafe(1), calls: new Set() })

// Stop the calls still running for a run (it ended, was stopped, or failed): their cells and checks don't run on.
export const stopCalls = (run: Run) => Effect.forEach([...run.calls], (f) => Fiber.interrupt(f), { discard: true })

// One call's answer, as text for the CLI. A call that already ended the run stops the rest: a CLI can send several calls
// together, and a cell run after "done" would change files after the user was told.
export const answer = (tool: string, args: unknown, hooks: Hooks, run: Run): Effect.Effect<string> => {
  if (run.ended) return Effect.succeed(`The run has already ended, so this call wasn't run. ${STOP}`)

  return Effect.gen(function* () {
    const result = yield* callTool(tool, args, hooks, run)
    if (!("answer" in result)) return result.output

    run.ended = result
    return result.waitingForUser ? `Waiting for user input; the task is not marked complete. ${STOP}` : `System One ran it: ${result.done ? "passed, and the task is finished" : "failed"}. ${STOP}`
  })
}

// Answer the relay's calls: one JSON line in ({ id, tool, args }), one out ({ id, text }). Each call runs with
// `context` (empty-vessel's, from the run: its Events, logger and services; without it, events printed over the TUI and logs
// missed the session), as a fiber the run keeps in `calls`. A call that fails or crashes still gets a reply, so the CLI
// isn't left waiting for its tool timeout.
export const serve = (path: string, hooks: Hooks, run: Run, context: Context.Context<never> = Context.empty()) =>
  Bun.listen<Wire>({
    unix: path,
    socket: {
      open: (s) => { s.data = newWire() },
      data: (s, chunk) => {
        for (const { id, tool, args } of receive(s, chunk)) {
          const reply = run.lock.withPermit(answer(String(tool), args, hooks, run)).pipe(
            Effect.catchCause((cause) => Effect.succeed(`the ${tool} call failed: ${Cause.hasFails(cause) ? String(Cause.squash(cause)) : Cause.pretty(cause)}`)),
            Effect.flatMap((text) => Effect.sync(() => send(s, { id, text }))),
          )
          const call: Fiber.Fiber<void> = Effect.runFork(reply.pipe(Effect.provideContext(context), Effect.ensuring(Effect.sync(() => run.calls.delete(call)))))
          run.calls.add(call)
        }
      },
      drain: flush,
    },
  })

// What an agent plugin gets: the MCP config to start its CLI with (one server, `server`, with the core's tools), how
// the run ended if a tool call ended it (a finishing check, waiting for the user), and whether a call is being answered.
export type ToolRelay = {
  readonly server: string
  readonly mcpConfig: { readonly mcpServers: Record<string, { readonly command: string; readonly args: ReadonlyArray<string>; readonly env?: Record<string, string> }> }
  readonly ended: () => Ended | undefined
  readonly busy: () => boolean
}

// Serve the tools for one run, in a scope: its own socket (a random, short name: several empty-vessels and their sub-agents
// never share one, and macOS caps a socket's path at ~104 bytes), closed and removed however the run ends, its calls
// stopped. The calls run with the caller's context. The compiled empty-vessel has the relay built in (empty-vessel --relay).
export const serveTools = (hooks: Hooks) =>
  Effect.gen(function* () {
    const socket = `/tmp/empty-vessel-${randomUUIDv7().slice(-12)}.sock`
    const run = newRun(hooks.stash)
    const context = yield* Effect.context<never>()
    yield* Effect.acquireRelease(
      Effect.sync(() => serve(socket, hooks, run, context)),
      (server) => stopCalls(run).pipe(Effect.andThen(Effect.sync(() => { server.stop(true); rmSync(socket, { force: true }) }))),
    )

    const compiled = (globalThis as { __emptyVesselKit?: string }).__emptyVesselKit !== undefined
    // The kernel tool's description names only what the kernel grants: the server is told which, when not everything.
    const env = hooks.grants && !allGranted(hooks.grants) ? { env: { EMPTY_VESSEL_GRANTS: JSON.stringify(hooks.grants) } } : {}
    const command = { command: process.execPath, args: compiled ? ["--relay", socket] : [SERVER, "--relay", socket], ...env }
    return { server: "kernel", mcpConfig: { mcpServers: { kernel: command } }, ended: () => run.ended, busy: () => run.calls.size > 0 } satisfies ToolRelay
  })
