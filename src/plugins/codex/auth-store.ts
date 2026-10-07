import { closeSync, chmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { Data, Effect, Redacted } from "effect"

/** Expiry is Unix time in milliseconds. Native refresh tokens belong only to this store. */
export interface CodexCredentials {
  access: string
  refresh: string
  expires: number
  accountId: string
}

export class CodexAuthError extends Data.TaggedError("CodexAuthError")<{ message: string }> {}

interface Options {
  file: string
  legacyFile: string
  refresh: (credentials: CodexCredentials) => Effect.Effect<CodexCredentials, CodexAuthError>
  now?: () => number
  lockWaitMs?: number
  /** Per-store durability operations; injectable without global filesystem mocks. */
  fs?: { fsyncSync?: typeof fsyncSync; renameSync?: typeof renameSync }
}

type Snapshot = { source: "native" | "legacy" | "none"; credentials: CodexCredentials | null }
const fail = (message: string) => new CodexAuthError({ message })
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const expiry = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
const code = (error: unknown) => object(error) ? error.code : undefined
const io = <A>(message: string, body: () => A) => Effect.try({ try: body, catch: () => fail(message) })

function credentials(value: unknown): CodexCredentials {
  if (!object(value) || Object.keys(value).sort().join() !== "access,accountId,expires,refresh" || !text(value.access) || !text(value.refresh) || !text(value.accountId) || !expiry(value.expires)) {
    throw new Error("Invalid credentials")
  }

  return { access: value.access, refresh: value.refresh, accountId: value.accountId, expires: value.expires }
}

function optionalFile(file: string): string | undefined {
  try {
    // A dangling symlink is not an absent native file: fail closed.
    if (!lstatSync(file).isFile()) throw new Error("Not a regular file")
  } catch (error) {
    if (code(error) === "ENOENT") return undefined
    throw error
  }

  return readFileSync(file, "utf8")
}

/** Lock files are never reaped on age alone. Abandoned/uncertain locks require explicit recovery. */
export function makeCodexAuthStore(options: Options) {
  const sync = options.fs?.fsyncSync ?? fsyncSync
  const rename = options.fs?.renameSync ?? renameSync
  const flushParent = () => {
    const fd = openSync(dirname(options.file), "r")
    try { sync(fd) } finally { closeSync(fd) }
  }
  const now = options.now ?? Date.now
  const lockFile = `${options.file}.lock`
  const waitMs = Number.isFinite(options.lockWaitMs) ? Math.max(0, Math.min(options.lockWaitMs!, 60_000)) : 5_000
  const prepare = io("Cannot prepare private Codex credential directory.", () => {
    const parent = dirname(options.file)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    if (!lstatSync(parent).isDirectory()) throw new Error("Invalid directory")
    chmodSync(parent, 0o700)
  })

  const snapshot = io("Invalid or unreadable Codex credentials. Run `empty-vessel login codex`; native credentials never fall back on errors.", (): Snapshot => {
    const native = optionalFile(options.file)

    if (native !== undefined) {
      const parsed: unknown = JSON.parse(native)
      if (!object(parsed) || Object.keys(parsed).sort().join() !== "credentials,version" || parsed.version !== 1) throw new Error("Invalid native envelope")
      return parsed.credentials === null ? { source: "none", credentials: null } : { source: "native", credentials: credentials(parsed.credentials) }
    }

    const legacy = optionalFile(options.legacyFile)
    if (legacy === undefined) return { source: "none", credentials: null }
    const parsed: unknown = JSON.parse(legacy)
    if (!object(parsed) || !object(parsed.tokens) || !text(parsed.tokens.access_token) || !text(parsed.tokens.account_id)) throw new Error("Invalid legacy credentials")
    const parts = parsed.tokens.access_token.split(".")
    if (parts.length !== 3 || !parts[1]) throw new Error("Invalid legacy token")
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    if (!object(claims) || !expiry(claims.exp) || !expiry(claims.exp * 1_000)) throw new Error("Invalid legacy expiry")

    return { source: "legacy", credentials: { access: parsed.tokens.access_token, refresh: "legacy-read-only", expires: claims.exp * 1_000, accountId: parsed.tokens.account_id } }
  })

  const persist = (value: CodexCredentials | null) => io("Cannot persist Codex credentials. Do not retry refresh; recover the lock and log in again.", () => {
    const temporary = `${options.file}.${randomUUID()}.tmp`
    let fd: number | undefined

    try {
      fd = openSync(temporary, "wx", 0o600)
      writeFileSync(fd, JSON.stringify({ version: 1, credentials: value }))
      sync(fd)
      closeSync(fd)
      fd = undefined
      rename(temporary, options.file)
      // The renamed credential must be durable before the quarantine lock is released.
      flushParent()
    } finally {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temporary) } catch (error) { if (code(error) !== "ENOENT") throw error }
    }
  })

  const locked = <A>(use: (retain: () => void) => Effect.Effect<A, CodexAuthError>): Effect.Effect<A, CodexAuthError> => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    yield* prepare
    const started = performance.now()
    let retained = false
    const nonce = randomUUID()

    const acquire = Effect.gen(function* () {
      while (true) {
        const acquired = yield* io("Cannot acquire Codex credential lock.", () => {
          let fd: number
          try { fd = openSync(lockFile, "wx", 0o600) } catch (error) {
            if (code(error) === "EEXIST") return false
            throw error
          }

          // Acquisition failures leave the newly created lock quarantined.
          try {
            writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), nonce }))
            sync(fd)
          } finally { closeSync(fd) }
          flushParent()
          return true
        })
        if (acquired) return

        const orphan = yield* io("Cannot inspect Codex credential lock. Stop its owner before manually removing the lock, then log in again.", () => {
          let owner: unknown
          try { owner = JSON.parse(readFileSync(lockFile, "utf8")) } catch { return false }
          if (!object(owner) || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return false
          try { process.kill(owner.pid as number, 0); return false } catch (error) { return code(error) === "ESRCH" }
        })

        if (orphan) return yield* Effect.fail(fail("Orphaned Codex credential lock. No lock was removed: verify its owner has stopped, remove the .lock file manually, then log in again before reading credentials."))
        if (performance.now() - started >= waitMs) return yield* Effect.fail(fail("Timed out waiting for Codex credential lock. If a refresh failed, stop its owner, remove the .lock file manually, and log in again. Never recover a lock by age alone."))
        yield* restore(Effect.sleep(Math.min(25, waitMs)))
      }
    })

    return yield* Effect.acquireUseRelease(acquire, () => use(() => { retained = true }), () => io("Cannot release Codex credential lock; explicit recovery is required.", () => {
      if (retained) return
      const owner: unknown = JSON.parse(readFileSync(lockFile, "utf8"))
      if (!object(owner) || owner.nonce !== nonce) throw new Error("Lock ownership changed")
      unlinkSync(lockFile)
    }))
  }))

  const exposed = (value: CodexCredentials) => ({ token: Redacted.make(value.access), accountId: value.accountId, expires: value.expires })
  const available = (state: Snapshot) => {
    if (!state.credentials) return Effect.fail(fail("No Codex login. Run `empty-vessel login codex` to continue."))
    if (state.source === "legacy" && state.credentials.expires <= now()) return Effect.fail(fail("Legacy Codex login expired. Run `codex login` or log in to empty-vessel; legacy credentials are never refreshed here."))
    return Effect.succeed(state.credentials)
  }

  const read = Effect.gen(function* () {
    const initial = yield* snapshot
    const current = yield* available(initial)
    if (initial.source !== "native" || current.expires > now() + 60_000) return exposed(current)

    return yield* locked((retain) => Effect.gen(function* () {
      // Another process may have refreshed, saved, or logged out while we waited.
      const state = yield* snapshot
      const latest = yield* available(state)
      if (state.source !== "native" || latest.expires > now() + 60_000) return exposed(latest)

      // The whole refresh -> persist transaction is masked from caller cancellation.
      // The refresh child remains interruptible by its own 30-second timeout.
      const checked = yield* Effect.gen(function* () {
        const rotated = yield* Effect.suspend(() => options.refresh(latest)).pipe(
          Effect.interruptible,
          Effect.timeout("30 seconds"),
        )
        return yield* io("Refresh returned invalid Codex credentials.", () => {
          const value = credentials(rotated)
          if (value.expires <= now() + 60_000) throw new Error("Refresh expiry too soon")
          return value
        })
      }).pipe(Effect.catchCause(() => Effect.gen(function* () {
        // Even a network failure may have consumed the old refresh token remotely.
        // Unlock only after a durable tombstone prevents retry and legacy fallback.
        yield* persist(null).pipe(Effect.tapError(() => Effect.sync(retain)))
        return yield* Effect.fail(fail("Codex refresh failed or timed out, or returned invalid credentials. Run `empty-vessel login codex`; no automatic retry was attempted."))
      })))
      yield* persist(checked).pipe(Effect.tapError(() => Effect.sync(retain)))
      return exposed(checked)
    }))
  })

  return {
    read,
    save: (value: CodexCredentials): Effect.Effect<void, CodexAuthError> => Effect.gen(function* () {
      const checked = yield* io("Invalid Codex credentials; nothing was saved.", () => credentials(value))
      yield* locked((retain) => persist(checked).pipe(Effect.tapError(() => Effect.sync(retain))))
    }),
    logout: locked((retain) => persist(null).pipe(Effect.tapError(() => Effect.sync(retain)))),
    status: snapshot.pipe(Effect.map((state): { source: "native" | "legacy" | "none"; expires?: number } => state.credentials ? { source: state.source, expires: state.credentials.expires } : { source: "none" })),
  }
}
