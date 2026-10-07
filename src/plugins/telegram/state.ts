import { createHash, randomUUID } from "node:crypto"
import { chmodSync, closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"

export const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const disk = <A>(work: () => A) => Effect.try({ try: work, catch: () => new Error("Telegram state unavailable") })
const privateDir = (path: string) => { mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700) }
export type State = { offset: number; session?: string }

// The lock is bot-wide, not project/chat/state-directory-wide. Never guess that an old lock is stale.
export const lockBot = (home: string, botId: number) => Effect.acquireRelease(
  Effect.try({
    try: () => {
      const parent = join(home, "telegram", "locks")
      privateDir(parent)
      const path = join(parent, String(botId))
      mkdirSync(path, { mode: 0o700 })
      return path
    },
    catch: () => new Error("Telegram bot lock unavailable; stop the other poller, or remove a stale lock after verifying it stopped"),
  }),
  (path) => disk(() => rmdirSync(path)).pipe(Effect.orDie),
)

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
