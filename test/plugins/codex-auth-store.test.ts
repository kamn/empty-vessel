import { afterEach, expect, test } from "bun:test"
import { Effect, Fiber, Redacted } from "effect"
import { chmodSync, existsSync, fstatSync, fsyncSync, renameSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir, hostname } from "node:os"
import { join } from "node:path"
import { CodexAuthError, makeCodexAuthStore, type CodexCredentials } from "../../src/plugins/codex/auth-store"

const roots: string[] = []
const clock = 1_800_000_000_000
const fresh: CodexCredentials = { access: "fake-access", refresh: "fake-refresh", expires: clock + 3_600_000, accountId: "fake-account" }
const expired = { ...fresh, expires: clock - 1 }
const run = Effect.runPromise
const fixture = (refresh: (value: CodexCredentials) => Effect.Effect<CodexCredentials, CodexAuthError> = () => Effect.die("Unexpected refresh")) => {
  const root = mkdtempSync(join(tmpdir(), "ev-codex-auth-"))
  roots.push(root)
  const options = { file: join(root, "private", "auth.json"), legacyFile: join(root, "legacy.json"), now: () => clock, lockWaitMs: 75, refresh }
  return { root, options, store: makeCodexAuthStore(options) }
}
const legacy = (path: string, expires = fresh.expires) => {
  const access = `header.${Buffer.from(JSON.stringify({ exp: expires / 1_000 })).toString("base64url")}.signature`
  writeFileSync(path, JSON.stringify({ tokens: { access_token: access, account_id: "legacy-account", refresh_token: "never-use" } }))
  return access
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

test("save survives restart with private permissions and redacted access; logout blocks fallback", async () => {
  const { store, options } = fixture()
  legacy(options.legacyFile)
  const legacyBefore = readFileSync(options.legacyFile, "utf8")
  await run(store.save(fresh))
  const restarted = makeCodexAuthStore(options)
  const auth = await run(restarted.read)
  expect(Redacted.value(auth.token)).toBe(fresh.access)
  expect(String(auth.token)).not.toContain(fresh.access)
  expect(await run(restarted.status)).toEqual({ source: "native", expires: fresh.expires })
  expect(statSync(options.file).mode & 0o777).toBe(0o600)
  expect(statSync(join(options.file, "..")).mode & 0o777).toBe(0o700)
  expect(JSON.parse(readFileSync(options.file, "utf8"))).toEqual({ version: 1, credentials: fresh })
  await run(restarted.logout)
  expect(JSON.parse(readFileSync(options.file, "utf8"))).toEqual({ version: 1, credentials: null })
  await expect(run(makeCodexAuthStore(options).read)).rejects.toThrow("No Codex login")
  expect(await run(restarted.status)).toEqual({ source: "none" })
  expect(readFileSync(options.legacyFile, "utf8")).toBe(legacyBefore)
})

test("missing and expired legacy credentials give login instructions without refreshing", async () => {
  let calls = 0
  const { store, options } = fixture(() => { calls++; return Effect.succeed(fresh) })
  expect(await run(store.status)).toEqual({ source: "none" })
  await expect(run(store.read)).rejects.toThrow("empty-vessel login codex")
  const access = legacy(options.legacyFile)
  expect(Redacted.value((await run(store.read)).token)).toBe(access)
  expect(await run(store.status)).toEqual({ source: "legacy", expires: fresh.expires })
  const before = readFileSync(options.legacyFile, "utf8")
  await run(store.read)
  expect(readFileSync(options.legacyFile, "utf8")).toBe(before)
  legacy(options.legacyFile, clock - 1_000)
  await expect(run(store.read)).rejects.toThrow("codex login")
  expect(calls).toBe(0)
  expect(existsSync(options.file)).toBe(false)
})

test("malformed native files fail closed and errors never include credential material", async () => {
  const { store, options } = fixture()
  legacy(options.legacyFile)
  mkdirSync(join(options.file, ".."), { recursive: true })
  const invalid = ["fake-secret-broken-json", JSON.stringify({ version: 2, credentials: fresh }), JSON.stringify({ version: 1, credentials: { ...fresh, expires: "123" } }), JSON.stringify({ version: 1, credentials: { ...fresh, refresh: "" } }), JSON.stringify({ version: 1, credentials: fresh, extra: true })]

  for (const raw of invalid) {
    writeFileSync(options.file, raw)
    const error = await run(store.read).catch((error: unknown) => error)
    expect(String(error)).toContain("Invalid or unreadable")
    expect(String(error)).not.toContain("fake-secret")
    expect(String(error)).not.toContain(fresh.access)
    await expect(run(store.status)).rejects.toThrow("Invalid or unreadable")
  }
})

test("schema rejects unsafe credentials before saving", async () => {
  const { store, options } = fixture()
  for (const value of [{ ...fresh, expires: NaN }, { ...fresh, expires: Infinity }, { ...fresh, accountId: "" }, { ...fresh, access: "" }]) {
    await expect(run(store.save(value))).rejects.toThrow("Invalid Codex credentials")
  }
  expect(existsSync(options.file)).toBe(false)
})

test("60-second expiry boundary refreshes once across concurrent store instances", async () => {
  let calls = 0
  const { store, options } = fixture((value) => Effect.gen(function* () {
    calls++
    expect(value.refresh).toBe(fresh.refresh)
    yield* Effect.sleep(30)
    return { ...fresh, access: "rotated-access", refresh: "rotated-refresh" }
  }))
  await run(store.save({ ...fresh, expires: clock + 60_000 }))
  const results = await run(Effect.all(Array.from({ length: 8 }, () => makeCodexAuthStore({ ...options, lockWaitMs: 1_000 }).read), { concurrency: "unbounded" }))
  expect(calls).toBe(1)
  expect(results.every((result) => Redacted.value(result.token) === "rotated-access")).toBe(true)
  expect(JSON.parse(readFileSync(options.file, "utf8")).credentials.refresh).toBe("rotated-refresh")
  expect(existsSync(`${options.file}.lock`)).toBe(false)
})

test("caller cancellation cannot discard rotated credentials", async () => {
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const { store, options } = fixture(() => Effect.gen(function* () {
    entered()
    yield* Effect.sleep(80)
    return { ...fresh, refresh: "rotation-survives-cancel" }
  }))
  await run(store.save(expired))
  const fiber = Effect.runFork(store.read)
  await started
  await run(Fiber.interrupt(fiber))
  expect(JSON.parse(readFileSync(options.file, "utf8")).credentials.refresh).toBe("rotation-survives-cancel")
  expect(existsSync(`${options.file}.lock`)).toBe(false)
})

test("failed persistence quarantines refresh rather than retrying consumed tokens", async () => {
  let calls = 0
  const { store, options } = fixture(() => Effect.sync(() => {
    calls++
    rmSync(options.file)
    mkdirSync(options.file)
    return { ...fresh, refresh: "rotated-but-not-persisted" }
  }))
  await run(store.save(expired))
  await expect(run(store.read)).rejects.toThrow("Do not retry refresh")
  expect(existsSync(`${options.file}.lock`)).toBe(true)
  rmSync(options.file, { recursive: true })
  writeFileSync(options.file, JSON.stringify({ version: 1, credentials: expired }))
  await expect(run(store.read)).rejects.toThrow("Timed out waiting")
  expect(calls).toBe(1)
})

for (const failure of ["network", "revoked", "invalid", "expired", "defect"] as const) {
  test(`${failure} refresh failure tombstones durably and permits re-login and logout`, async () => {
    let calls = 0
    const { store, options } = fixture(() => {
      calls++
      if (failure === "invalid") return Effect.succeed({ ...fresh, refresh: "" })
      if (failure === "expired") return Effect.succeed(expired)
      if (failure === "defect") return Effect.die("fake-secret-defect")
      return Effect.fail(new CodexAuthError({ message: `fake-secret-${failure}` }))
    })
    legacy(options.legacyFile)
    const before = readFileSync(options.legacyFile, "utf8")
    await run(store.save(expired))
    const error = await run(store.read).catch((error: unknown) => error)
    expect(String(error)).toContain("empty-vessel login codex")
    expect(String(error)).not.toContain("fake-secret")
    expect(existsSync(`${options.file}.lock`)).toBe(false)
    expect(JSON.parse(readFileSync(options.file, "utf8"))).toEqual({ version: 1, credentials: null })
    const restarted = makeCodexAuthStore(options)
    expect(await run(restarted.status)).toEqual({ source: "none" })
    await expect(run(restarted.read)).rejects.toThrow("No Codex login")
    await run(restarted.logout)
    await run(restarted.save(fresh))
    expect(Redacted.value((await run(restarted.read)).token)).toBe(fresh.access)
    await run(restarted.logout)
    expect(await run(restarted.status)).toEqual({ source: "none" })
    expect(readFileSync(options.legacyFile, "utf8")).toBe(before)
    expect(calls).toBe(1)
  })
}

for (const failedRefresh of [false, true]) {
  test(`durability ordering before refresh and ${failedRefresh ? "tombstone" : "rotation"} unlock`, async () => {
    const events: string[] = []
    const { store, options } = fixture(() => {
      events.push("refresh")
      return failedRefresh ? Effect.fail(new CodexAuthError({ message: "revoked" })) : Effect.succeed(fresh)
    })
    await run(store.save(expired))
    const lock = `${options.file}.lock`
    const instrumented = makeCodexAuthStore({ ...options, fs: {
      fsyncSync(fd) {
        expect(existsSync(lock)).toBe(true)
        const stat = fstatSync(fd)
        const kind = stat.isDirectory() ? "directory" : stat.ino === statSync(lock).ino ? "lock" : "credentials"
        if (kind === "lock") expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid)
        events.push(kind)
        fsyncSync(fd)
      },
      renameSync(from, to) {
        events.push("rename")
        renameSync(from, to)
      },
    } })
    if (failedRefresh) await expect(run(instrumented.read)).rejects.toThrow("empty-vessel login codex")
    else await run(instrumented.read)
    expect(events).toEqual(["lock", "directory", "refresh", "credentials", "rename", "directory"])
    expect(existsSync(lock)).toBe(false)
  })
}

for (const stage of ["lock", "lock-directory", "credentials", "rename", "credential-directory"] as const) {
  for (const failedRefresh of [false, true]) {
    test(`${stage} durability failure quarantines ${failedRefresh ? "invalidation" : "rotation"}`, async () => {
      let calls = 0
      const { store, options } = fixture(() => {
        calls++
        return failedRefresh ? Effect.fail(new CodexAuthError({ message: "revoked" })) : Effect.succeed(fresh)
      })
      legacy(options.legacyFile)
      const before = readFileSync(options.legacyFile, "utf8")
      await run(store.save(expired))
      const lock = `${options.file}.lock`
      let directories = 0
      const broken = makeCodexAuthStore({ ...options, fs: {
        fsyncSync(fd) {
          const stat = fstatSync(fd)
          const kind = stat.isDirectory() ? (++directories === 1 ? "lock-directory" : "credential-directory") : stat.ino === statSync(lock).ino ? "lock" : "credentials"
          if (kind === stage) throw new Error("fake-secret-fsync")
          fsyncSync(fd)
        },
        renameSync(from, to) {
          if (stage === "rename") throw new Error("fake-secret-rename")
          renameSync(from, to)
        },
      } })
      const error = await run(broken.read).catch((error: unknown) => error)
      expect(String(error)).toContain(stage.startsWith("lock") ? "Cannot acquire" : "Cannot persist")
      expect(String(error)).not.toContain("fake-secret")
      expect(existsSync(lock)).toBe(true)
      expect(calls).toBe(stage.startsWith("lock") ? 0 : 1)
      await expect(run(store.save(fresh))).rejects.toThrow("Timed out waiting")
      await expect(run(store.logout)).rejects.toThrow("Timed out waiting")
      // Simulate the pre-rename state surviving a crash: quarantine prevents reuse.
      writeFileSync(options.file, JSON.stringify({ version: 1, credentials: expired }))
      await expect(run(store.read)).rejects.toThrow("Timed out waiting")
      expect(calls).toBe(stage.startsWith("lock") ? 0 : 1)
      expect(readFileSync(options.legacyFile, "utf8")).toBe(before)
    })
  }
}

test("locks have bounded waits and dead owners require explicit recovery, never age-based reaping", async () => {
  const { store, options } = fixture()
  await run(store.save(fresh))
  const lock = `${options.file}.lock`
  const owner = JSON.stringify({ pid: process.pid, host: hostname(), nonce: "other-owner", created: 0 })
  writeFileSync(lock, owner)
  await expect(run(store.logout)).rejects.toThrow("Timed out waiting")
  expect(readFileSync(lock, "utf8")).toBe(owner)
  writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, host: hostname(), nonce: "dead" }))
  await expect(run(store.logout)).rejects.toThrow("Orphaned Codex credential lock")
  expect(existsSync(lock)).toBe(true)
})

test("save repairs existing parent permissions", async () => {
  const { store, options } = fixture()
  mkdirSync(join(options.file, ".."), { recursive: true, mode: 0o755 })
  chmodSync(join(options.file, ".."), 0o755)
  await run(store.save(fresh))
  expect(statSync(join(options.file, "..")).mode & 0o777).toBe(0o700)
})

test("separate Bun processes serialize reread-refresh-persist", async () => {
  const { store, options, root } = fixture()
  await run(store.save(expired))
  const counter = join(root, "refresh-count")
  const source = `import { Effect } from 'effect'; import { appendFileSync } from 'node:fs'; import { makeCodexAuthStore } from './src/plugins/codex/auth-store'; const store = makeCodexAuthStore({ file: ${JSON.stringify(options.file)}, legacyFile: ${JSON.stringify(options.legacyFile)}, now: () => ${clock}, lockWaitMs: 3000, refresh: () => Effect.gen(function* () { appendFileSync(${JSON.stringify(counter)}, 'refresh\\n'); yield* Effect.sleep(100); return ${JSON.stringify(fresh)} }) }); await Effect.runPromise(store.read);`
  const children = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, "-e", source], { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" }))
  const exits = await Promise.all(children.map(async (child) => ({ code: await child.exited, error: await new Response(child.stderr).text() })))
  expect(exits).toEqual(exits.map(() => ({ code: 0, error: "" })))
  expect(readFileSync(counter, "utf8")).toBe("refresh\n")
})

test("supplied refresh timeout bounds the masked transaction and redacts its failure", async () => {
  const { store, options } = fixture(() => Effect.never.pipe(
    Effect.timeout(20),
    Effect.mapError(() => new CodexAuthError({ message: "fake-timeout-secret" })),
  ))
  await run(store.save(expired))
  const started = performance.now()
  await expect(run(store.read)).rejects.toThrow("refresh failed or timed out")
  expect(performance.now() - started).toBeLessThan(1_000)
  expect(existsSync(`${options.file}.lock`)).toBe(false)
  expect(await run(store.status)).toEqual({ source: "none" })
  await run(store.save(fresh))
  expect(Redacted.value((await run(store.read)).token)).toBe(fresh.access)
})

test("cancelling a lock waiter does not remove another owner's lock", async () => {
  const { store, options } = fixture()
  await run(store.save(expired))
  const lock = `${options.file}.lock`
  const owner = JSON.stringify({ pid: process.pid, host: hostname(), nonce: "someone-else" })
  writeFileSync(lock, owner)
  const waiting = Effect.runFork(makeCodexAuthStore({ ...options, lockWaitMs: 5_000 }).read)
  await run(Effect.sleep(20))
  await run(Fiber.interrupt(waiting))
  expect(readFileSync(lock, "utf8")).toBe(owner)
})

test("logout serialized after refresh cannot resurrect credentials", async () => {
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const { store, options } = fixture(() => Effect.gen(function* () {
    entered()
    yield* Effect.sleep(30)
    return fresh
  }))
  await run(store.save(expired))
  const reading = run(store.read)
  await started
  await run(makeCodexAuthStore({ ...options, lockWaitMs: 1_000 }).logout)
  await reading
  await expect(run(store.read)).rejects.toThrow("No Codex login")
  expect(JSON.parse(readFileSync(options.file, "utf8"))).toEqual({ version: 1, credentials: null })
})
