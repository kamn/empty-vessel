import { appendFile, mkdir, open, rename, rm, stat } from "node:fs/promises"
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
// The lock is a file created with "fail if it exists"; it's removed afterwards, even if `use` fails.
export const withLock = <A, E, R>(path: string, use: Effect.Effect<A, E, R>) => {
  const lock = `${path}.lock`
  const acquire = Effect.promise(async () => {
    await mkdir(dirname(lock), { recursive: true })
    for (const started = Date.now(); Date.now() - started < GIVE_UP_MS; await Bun.sleep(WAIT_MS)) {
      try { await (await open(lock, "wx")).close(); return } catch {}
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0)
      if (age > STALE_MS) await rm(lock, { force: true })
    }
    // ponytail: after 10s, go ahead without the lock (worst case: one lost update) rather than hang a turn
  })

  return Effect.acquireUseRelease(acquire, () => use, () => Effect.promise(() => rm(lock, { force: true })))
}

// One line per change to a shared file (what, why, from where), so an automatic change can be found and undone.
// Small appends of one line don't interleave, so no lock is needed.
export const appendHistory = (path: string, entry: Readonly<Record<string, unknown>>) =>
  Effect.promise(() => mkdir(dirname(path), { recursive: true }).then(() => appendFile(path, `${JSON.stringify({ ...entry, ts: Date.now() })}\n`)))
