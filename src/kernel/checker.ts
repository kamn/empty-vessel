import { basename, resolve } from "node:path"

// The type check as a language server (TypeScript 7's `tsc --lsp --stdio`), one per kernel folder: it keeps Effect's and
// Bun's types loaded, so checking a new cell takes milliseconds instead of a fresh `tsc` reloading ~430 files each time.
// LSP rather than `tsc --api`: plain JSON-RPC over stdio, and pull diagnostics
// (textDocument/diagnostic) answer one file on request, with no watcher in between. A checker that can't start or
// answer in time says so (undefined) and the kernel falls back to `tsc` per cell: the check is never skipped. It never
// keeps the process alive (unref), and ends after IDLE_MS unused; the next check starts it again.

const IDLE_MS = 60_000
const FIRST_MS = 20_000 // the first check loads the types
const NEXT_MS = 5_000

type Pending = (message: { result?: any; error?: unknown }) => void
type Server = { readonly request: (method: string, params: object, ms: number) => Promise<any>; readonly notify: (method: string, params: object) => void; readonly kill: () => void; readonly exited: Promise<number>; dead: boolean }

const start = (tsc: string, dir: string): Server => {
  const proc = Bun.spawn([tsc, "--lsp", "--stdio"], { cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "ignore" })
  proc.unref()
  const waiting = new Map<number, Pending>()
  const server: Server = {
    dead: false,
    exited: proc.exited,
    notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
    request: (method, params, ms) => new Promise((resolve, reject) => {
      if (server.dead) { reject(new Error("language server closed")); return }

      const id = ++next
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`${method}: no answer in ${ms} ms`)) }, ms)
      timer.unref()
      waiting.set(id, (m) => { clearTimeout(timer); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) })
      send({ jsonrpc: "2.0", id, method, params })
    }),
    kill: () => { close(); proc.kill() },
  }
  const close = () => {
    server.dead = true

    for (const settle of waiting.values()) {
      settle({ error: "language server closed" })
    }

    waiting.clear()
  }

  let next = 0
  const send = (m: object) => {
    if (server.dead) return
    const body = Buffer.from(JSON.stringify(m))
    proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    proc.stdin.write(body)
    proc.stdin.flush()
  }

  // Messages in, framed by Content-Length. The server's own requests (configuration, capabilities) get an empty answer.
  const read = proc.stdout.getReader()
  let buf = Buffer.alloc(0)
  const pump = async () => {
    for (;;) {
      const { done, value } = await read.read()
      if (done) break
      buf = Buffer.concat([buf, value])

      for (;;) {
        const head = buf.indexOf("\r\n\r\n")
        if (head < 0) break
        const length = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, head).toString())?.[1])
        if (buf.length < head + 4 + length) break
        const m = JSON.parse(buf.subarray(head + 4, head + 4 + length).toString())
        buf = buf.subarray(head + 4 + length)
        if (m.method && m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: null })
        else if (m.id !== undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id) }
      }
    }
  }
  pump().catch(() => {}).finally(close)
  ;(read as unknown as { unref?: () => void }).unref?.()
  return server
}

// One checker for every kernel in this process (each kernel folder is its own project to it, by its tsconfig.json),
// so temporary kernels (promote's check, System One's tool runs) share it instead of each starting one, and the type
// files loaded for one folder serve the next. `seen`: folders it has checked before (their first check is slower).
type Checker = { readonly server: Server; readonly ready: Promise<boolean>; readonly seen: Set<string>; idle?: ReturnType<typeof setTimeout> }
const checkers = new Map<string, Checker>()
const closing = new Map<string, Promise<void>>()

const checkerFor = (tsc: string, dir: string) => {
  const known = checkers.get(tsc)
  if (known && !known.server.dead) return known

  const server = start(tsc, dir)
  const ready = server.request("initialize", { processId: process.pid, rootUri: null, capabilities: { textDocument: { diagnostic: {} } } }, FIRST_MS)
    .then(() => { server.notify("initialized", {}); return true }, () => { server.kill(); return false })
  const entry: Checker = { server, ready, seen: new Set() }
  checkers.set(tsc, entry)
  return entry
}

// Stop the shared checker for this compiler and wait until it releases its working directory.
// Owners of temporary projects call this after all their kernel work finishes, before deleting them.
// Other kernels can start a fresh checker on their next check; closing twice is harmless.
export const closeChecker = async (tsc: string): Promise<void> => {
  const key = resolve(tsc)
  const pending = closing.get(key)
  const entry = checkers.get(key)
  if (!entry) {
    await pending
    return
  }

  checkers.delete(key)
  clearTimeout(entry.idle)
  entry.server.kill()
  const stopped = Promise.all([pending, entry.server.exited]).then(() => {})
  closing.set(key, stopped)

  try {
    await stopped
  } finally {
    if (closing.get(key) === stopped) closing.delete(key)
  }
}

// Start the checker (when a kernel opens), so the first cell doesn't wait for it.
export const warmChecker = (tsc: string, dir: string) => { checkerFor(tsc, dir) }

// The cell's type errors as tsc prints them ("cell-3.ts(2,14): error TS2322: …"), "" for none, or undefined when the
// checker couldn't answer (the caller then runs tsc). `changed`: files written since the last check (the cell's scope,
// the tool sources), so the server reads them now rather than from a stale copy.
export const checkWithServer = async (tsc: string, dir: string, file: string, changed: ReadonlyArray<string>) => {
  const entry = checkerFor(tsc, dir)
  if (!(await entry.ready)) return undefined
  clearTimeout(entry.idle)

  const { server } = entry
  const uri = `file://${file}`
  try {
    server.notify("workspace/didChangeWatchedFiles", { changes: changed.map((f) => ({ uri: `file://${f}`, type: 1 })) })
    server.notify("textDocument/didOpen", { textDocument: { uri, languageId: "typescript", version: 1, text: await Bun.file(file).text() } })
    const report = await server.request("textDocument/diagnostic", { textDocument: { uri } }, entry.seen.has(dir) ? NEXT_MS : FIRST_MS)
    server.notify("textDocument/didClose", { textDocument: { uri } })
    entry.seen.add(dir)

    // No previousResultId was sent: only a full report can establish that this cell was checked.
    // Missing diagnostics (or an unchanged report) are not a successful check: use the fallback.
    if (report?.kind !== "full" || !Array.isArray(report.items)) throw new Error("invalid diagnostic report")

    const errors = report.items.filter((d: { severity?: number }) => (d.severity ?? 1) === 1)
    return errors.map((d: { range: { start: { line: number; character: number } }; code?: number | string; message: string }) =>
      `${basename(file)}(${d.range.start.line + 1},${d.range.start.character + 1}): error TS${d.code ?? ""}: ${d.message}`).join("\n")
  } catch {
    server.kill() // a checker that didn't answer is restarted next time
    return undefined
  } finally {
    if (checkers.get(tsc) === entry && !server.dead) {
      entry.idle = setTimeout(() => { if (checkers.get(tsc) === entry) checkers.delete(tsc); server.kill() }, IDLE_MS)
      entry.idle.unref()
    }
  }
}
