import { createHash, randomUUID } from "node:crypto"
import { chmodSync, closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { takeLease } from "empty-vessel"

export const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const disk = <A>(work: () => A) => Effect.try({ try: work, catch: () => new Error("Telegram state unavailable") })
const privateDir = (path: string) => { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700) }
export type State = { offset: number; session?: string }

// The lock is bot-wide, not project/chat/state-directory-wide. Its owner.json is a lease (KTD8): a crashed poller's lock
// is taken over (its pid is dead, ours, or started at another time), so a restart needs no manual cleanup. The lease
// counts our own pid as free, so pollers in this process are kept apart by `held`.
const held = new Set<string>()
export const lockBot = (home: string, botId: number) => {
  const path = join(home, "telegram", "locks", String(botId))
  const unavailable = () => new Error("Telegram bot lock unavailable; another poller for this bot is running: stop it first")
  const acquire = Effect.gen(function* () {
    if (held.has(path)) return yield* Effect.fail(unavailable())
    held.add(path)
    const holder = yield* disk(() => { privateDir(join(path, "..")); privateDir(path) }).pipe(Effect.andThen(takeLease(join(path, "owner.json"))), Effect.onError(() => Effect.sync(() => held.delete(path))))
    if (holder) { held.delete(path); return yield* Effect.fail(unavailable()) }
    return path
  })

  return Effect.acquireRelease(acquire, () => disk(() => { rmSync(path, { recursive: true, force: true }); held.delete(path) }).pipe(Effect.orDie))
}

export const openState = (directory: string, tokenHash: string, chat: string, project: string) => disk(() => {
  privateDir(directory)
  const key = hash(JSON.stringify([tokenHash, chat, realpathSync(project)]))
  const path = join(directory, `${key}.json`)
  let current: State = { offset: 0 }

  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const parsed = JSON.parse(readFileSync(fd, "utf8"))
      if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0 ||
        (parsed.session !== undefined && typeof parsed.session !== "string")) throw new Error()
      current = { offset: parsed.offset, ...(parsed.session !== undefined ? { session: parsed.session } : {}) }
      chmodSync(path, 0o600)
    } finally { closeSync(fd) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const save = (patch: Partial<State>) => disk(() => {
    const next = { ...current, ...patch }
    const temp = `${path}.${randomUUID()}.tmp`
    const fd = openSync(temp, "wx", 0o600)

    try {
      try {
        writeFileSync(fd, JSON.stringify(next))
        fsyncSync(fd)
      } finally { closeSync(fd) }

      renameSync(temp, path)
      const dir = openSync(directory, "r")
      try { fsyncSync(dir) } finally { closeSync(dir) }
      current = next
    } finally {
      try { unlinkSync(temp) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
  })

  return { get: () => current, save }
})
