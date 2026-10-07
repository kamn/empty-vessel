import { readFileSync } from "node:fs"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"

// The kernel's side inside a cell's Worker: calls to the host (the program that runs the kernel), and earlier results.
// Every generated scope re-exports these, so a cell can `yield* call("name", arg)` and `result(3)`.

declare const self: Worker

let next = 0
const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

// A host function by name (the host decides which exist, e.g. "systemOne" or "spawn"); waits for its answer.
export const call = (fn: string, arg?: unknown): Effect.Effect<unknown, Error> =>
  Effect.tryPromise({
    try: () => new Promise((resolve, reject) => {
      const id = ++next
      waiting.set(id, { resolve, reject })
      self.postMessage({ type: "call", id, fn, arg })
    }),
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })

// The worker passes the host's replies here.
export const answer = (reply: { id: number; value?: unknown; error?: string }) => {
  const w = waiting.get(reply.id)
  if (!w) return
  waiting.delete(reply.id)
  if (reply.error !== undefined) w.reject(new Error(reply.error))
  else w.resolve(reply.value)
}

// Tool sources (MCP servers…) as a service, so a cell's Effects say in their requirements that they reach outside.
// The kernel's built-ins provide it (as calls to the host's $source); sources.ts calls it.
export class Sources extends Context.Service<Sources, { readonly call: (source: string, tool: string, args: unknown) => Effect.Effect<any, Error> }>()("kernel/Sources") {}
export const sourcesThroughHost = Sources.of({ call: (source, tool, args) => call("$source", { source, tool, args }) })

// An earlier cell's result ($N), as the kernel stored it (JSON).
export const result = (n: number): unknown => JSON.parse(readFileSync(`${process.env.KERNEL_DIR}/results/${n}.json`, "utf8"))

// Plain data survives being saved as JSON unchanged: primitives, arrays, and plain objects of them. Maps, Dates,
// class instances, Effects and functions don't (they'd come back as something else).
export const isPlainData = (v: unknown, depth = 0): boolean => {
  if (v === null || ["string", "number", "boolean"].includes(typeof v)) return typeof v !== "number" || Number.isFinite(v)
  if (depth > 50 || typeof v !== "object") return false
  if (Array.isArray(v)) return v.every((x) => isPlainData(x, depth + 1))
  const proto = Object.getPrototypeOf(v)
  return (proto === Object.prototype || proto === null) && Object.values(v as object).every((x) => isPlainData(x, depth + 1))
}
