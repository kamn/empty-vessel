import { execFileSync } from "node:child_process"
import { appendFile, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { Effect } from "effect"

// Files shared by several empty-vessel processes at once (sessions in different repos, the reviewer).

// Write a whole file so readers see the old version or the new one, never half: write a temp file, then rename
// it over the real one (a rename is all-or-nothing on the same disk).
export const writeAtomic = (path: string, text: string) =>
  Effect.promise(async () => {
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${crypto.randomUUID()}.tmp` // unique even for two writes in the same millisecond
    await Bun.write(temp, text)
    await rename(temp, path)
  })

const STALE_MS = 30_000 // a lock older than this belongs to a process that crashed
const WAIT_MS = 50, GIVE_UP_MS = 10_000

// Run `use` while holding `<path>.lock`, so read → change → write by two processes can't lose one's change.
// The lock is a file created with "fail if it exists", holding a token of its own; it's removed afterwards, even if `use`
// fails, but only if it still holds that token: a writer that gave up waiting (below) or whose lock was taken as stale
// never removes another's.
// ponytail: breaking a stale lock is check-then-remove, so two waiters can both break one; rare (a crashed holder and
// two waiters at once), worst case one lost update.
export const withLock = <A, E, R>(path: string, use: Effect.Effect<A, E, R>) => {
  const lock = `${path}.lock`
  const token = crypto.randomUUID()
  const acquire = Effect.promise(async () => {
    await mkdir(dirname(lock), { recursive: true })
    for (const started = Date.now(); Date.now() - started < GIVE_UP_MS; await Bun.sleep(WAIT_MS)) {
      try {
        const file = await open(lock, "wx")
        await file.writeFile(token)
        await file.close()
        return true
      } catch {}
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0)
      if (age > STALE_MS) await rm(lock, { force: true })
    }
    return false // ponytail: after 10s, go ahead without the lock (worst case: one lost update) rather than hang a turn
  })
  const release = (held: boolean) => Effect.promise(async () => {
    if (held && (await readFile(lock, "utf8").catch(() => "")) === token) await rm(lock, { force: true })
  })

  return Effect.acquireUseRelease(acquire, () => use, release)
}

// One line per change to a shared file (what, why, from where), so an automatic change can be found and undone.
// Small appends of one line don't interleave, so no lock is needed.
export const appendHistory = (path: string, entry: Readonly<Record<string, unknown>>) =>
  Effect.promise(() => mkdir(dirname(path), { recursive: true }).then(() => appendFile(path, `${JSON.stringify({ ...entry, ts: Date.now() })}\n`)))

// When process `pid` started, as `ps` prints it (the same text each time for one process), or undefined if there's no
// such process. With the pid, it names one process even after the pid is reused.
export const processStart = (pid: number): string | undefined => {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1000, env: { ...process.env, LC_ALL: "C" } }).trim() || undefined
  } catch { return undefined }
}
let ownStart: string | undefined
// This process's start, as processStart gives it (asked once).
export const myStart = () => (ownStart ??= processStart(process.pid) ?? "unknown")

// An owner lease (KTD8): `path` names the one process that owns something, as { pid, startedAt }. Taking it succeeds
// (undefined) when nobody holds it, or its holder is gone: its pid is dead, is this process, or now belongs to a process
// that started at another time. Otherwise it gives the live holder, and leaves the lease as it was.
// Not withLock: that gives up after 10s and breaks any lock older than 30s, even a live owner's.
// ponytail: check-then-write, so two processes taking a dead holder's lease at the same instant can both win; a create-
// exclusive handover if that race shows up.
export type Owner = { readonly pid: number; readonly startedAt: string }
export const takeLease = (path: string) =>
  Effect.gen(function* () {
    const held = yield* Effect.promise(() => readFile(path, "utf8").then((t) => JSON.parse(t) as Partial<Owner>, () => undefined))
    const live = typeof held?.pid === "number" && held.pid !== process.pid && processStart(held.pid) === held.startedAt
    if (live) return held as Owner

    yield* writeAtomic(path, JSON.stringify({ pid: process.pid, startedAt: myStart() }))
    return undefined
  })
