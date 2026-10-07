import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { guardGlobals } from "./guard"
import { answer, Sources, sourcesThroughHost } from "./runtime"

// One cell, in its own Worker: import it, run its action (the default export) once, report back. Console output goes
// to the host as log lines (a Worker's console would print straight onto the host's terminal).

declare const self: Worker

const text = (v: unknown) => (typeof v === "string" ? v : Bun.inspect(v, { depth: 4 }))
const log = (...args: ReadonlyArray<unknown>) => self.postMessage({ type: "log", text: args.map(text).join(" ") })
Object.assign(console, { log, info: log, warn: log, error: log, debug: log })
// In a Worker, process.exit doesn't stop the code that called it; make it fail the cell instead of quietly going on.
// Host calls so far (call() posts { type: "call" }): a cell's top level may make none (see below).
let hostCalls = 0
const post = self.postMessage.bind(self)
self.postMessage = ((m: { type?: string }) => { if (m?.type === "call") hostCalls++; post(m) }) as typeof self.postMessage
process.exit = ((code?: number) => { throw new Error(`process.exit(${code ?? ""}) isn't allowed in a cell: return or throw instead`) }) as typeof process.exit
guardGlobals() // raw side effects fail when a cell calls them (src/kernel/guard.ts)

// A value as JSON the host can store: Maps and Sets as objects and arrays, bigints as strings, functions described.
export const encode = (value: unknown) =>
  JSON.stringify(value ?? null, (_, v) =>
    v instanceof Map ? Object.fromEntries(v)
    : v instanceof Set ? [...v]
    : typeof v === "bigint" ? v.toString()
    : typeof v === "function" ? `[function ${v.name || "anonymous"}]`
    : v)

// The action: an Effect (run with the built-ins' layer, if the built-ins export one), a function, a promise, or a value.
// The action runs as a fiber the host can stop: a "stop" message interrupts it, so what it started cleans up (bash kills
// its process group on interruption). Ending the Worker from outside alone would leave those commands running.
let running: Fiber.Fiber<unknown, unknown> | undefined
const perform = async (action: unknown, layer: unknown) => {
  const got = typeof action === "function" ? await action() : await action // a function's result, if it's an Effect, runs too
  if (!Effect.isEffect(got)) return got

  // The kernel's own service (tool sources through the host) and the built-ins' layer (their services), if any.
  const services = Layer.isLayer(layer) ? Layer.merge(Layer.succeed(Sources, sourcesThroughHost), layer as unknown as Layer.Layer<never>) : Layer.succeed(Sources, sourcesThroughHost)
  running = Effect.runFork(Effect.provide(got, services) as Effect.Effect<unknown, unknown>)
  const exit = await Effect.runPromise(Fiber.await(running))
  running = undefined
  if (Exit.isSuccess(exit)) return exit.value
  throw Cause.squash(exit.cause)
}

self.onmessage = async (e: MessageEvent) => {
  const message = e.data
  if (message.type === "reply") return answer(message)
  if (message.type === "stop") {
    if (running) await Effect.runPromise(Fiber.interrupt(running))
    return self.postMessage({ type: "stopped" })
  }
  if (message.type !== "run") return

  try {
    const before = hostCalls
    const cell = await import(message.file)
    // Loading a cell only defines things (later cells import it, and that must cost nothing): a top level that asked
    // the host (System One, spawn…) did work there.
    if (hostCalls > before) throw new Error("the top level did work (it called the host while the cell loaded): do the work inside an Effect (the default export, or a function), and remember(...) what's costly")
    const builtins = message.builtins ? await import(message.builtins) : {}
    const defines = Object.keys(cell).filter((k) => k !== "default")

    const value = "default" in cell ? await perform(cell.default, builtins.layer) : undefined
    self.postMessage({ type: "done", defines, value: encode(value), ran: "default" in cell })
  } catch (err) {
    self.postMessage({ type: "done", defines: [], error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
  }
}
