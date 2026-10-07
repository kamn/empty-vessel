// The runtime side of a cell's rules, in a cell's Worker:
// - Bun's files and processes, the network and workers always fail there. Nothing empty-vessel runs in a Worker needs them
//   from the globals: its tools use node:fs (which a cell can't import) and `raw`, kept before they're blocked.
// - Timers, the clock and randomness fail only when a cell or library tool calls them directly, since Effect's runtime
//   needs them. The caller is read from the call stack, which is best effort: the engine can optimise a small
//   function's frame away (seen: `Effect.sync(() => D.now())` with `const D = Date` got through), so the source scan
//   (rules.ts) is the main check for these.
// ponytail: guard rails, not a sandbox (a cell can still reach around them on purpose).

// Kept before guardGlobals blocks them, for empty-vessel's own tools in a Worker (bash).
export const raw = { spawn: Bun.spawn.bind(Bun) }

const SRC = new URL("..", import.meta.url).pathname // empty-vessel's src/
const HERE = new URL(import.meta.url).pathname

// The file that called into the guarded function (skipping this file and frames with no path, e.g. native ones).
export const callerFile = (skip = 0): string | undefined => {
  const frames = (new Error().stack ?? "").split("\n").slice(1)
    .map((l) => l.match(/\(?((?:file:\/\/)?\/[^():]+):\d+:\d+\)?\s*$/)?.[1]?.replace(/^file:\/\//, ""))
    .filter((f): f is string => f !== undefined && f !== HERE)
  return frames[skip]
}

// Code that may use raw side effects: empty-vessel's own source and installed packages. Everything else (cells, library
// tools, text written into a kernel folder) goes through the services.
const trusted = (file: string | undefined) => file === undefined || file.startsWith(SRC) || file.includes("/node_modules/")

// The nearest calling file outside empty-vessel's code and packages: the cell (or library tool) behind a call.
export const outsideCaller = (): string | undefined => {
  for (let skip = 0; ; skip++) {
    const file = callerFile(skip)
    if (file === undefined || !trusted(file)) return file
  }
}

const blocked = (what: string) => new Error(`${what} isn't available in a cell: use the kernel's services (read, readText, write, edit, bash, now, random; Effect.sleep for waiting)`)

const guardFunction = (owner: any, key: string, what: string, always = false) => {
  const original = owner[key]
  if (typeof original !== "function") return
  const wrapped = function (this: unknown, ...args: Array<unknown>) {
    if (always || !trusted(callerFile())) throw blocked(what)
    return new.target ? Reflect.construct(original, args, new.target) : original.apply(this, args)
  }
  // Some of Bun's are writable but not configurable: assignment works where redefining wouldn't.
  try { owner[key] = wrapped } catch {}
  if (owner[key] !== wrapped) try { Object.defineProperty(owner, key, { value: wrapped }) } catch {}
  if (owner[key] !== wrapped) throw new Error(`the kernel couldn't guard ${what}`) // fail loudly rather than leave it open
}

// Once, in a cell's Worker, before any cell loads.
export const guardGlobals = () => {
  for (const key of ["spawn", "spawnSync", "file", "write", "$", "serve", "connect", "listen", "udpSocket"]) guardFunction(Bun, key, `Bun.${key}`, true)
  for (const key of ["fetch", "WebSocket", "Worker"]) guardFunction(globalThis, key, key, true)
  for (const key of ["setTimeout", "setInterval", "setImmediate"]) guardFunction(globalThis, key, key)
  guardFunction(Date, "now", "Date.now")
  guardFunction(Math, "random", "Math.random")
  guardFunction(performance, "now", "performance.now")
  guardFunction(crypto, "randomUUID", "crypto.randomUUID")
  guardFunction(crypto, "getRandomValues", "crypto.getRandomValues")
}
