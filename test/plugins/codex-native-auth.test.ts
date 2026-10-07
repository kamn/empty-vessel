import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"

const fixture = "./test/fixtures/codex-native-auth.case.ts"
const isolated = <A, E>(use: (home: string) => Effect.Effect<A, E>) => Effect.acquireUseRelease(
  Effect.sync(() => {
    const home = mkdtempSync(join(tmpdir(), "empty-vessel-native-auth-test-"))
    mkdirSync(join(home, ".codex"))
    mkdirSync(join(home, ".empty-vessel/providers"), { recursive: true })
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
    writeFileSync(join(home, ".codex/auth.json"), JSON.stringify({ tokens: { access_token: `legacy.${payload}.signature`, account_id: "legacy-account", refresh_token: "legacy-refresh-secret" } }))
    writeFileSync(join(home, ".empty-vessel/config.json"), "{deliberately malformed config")
    return home
  }),
  use,
  (home) => Effect.sync(() => rmSync(home, { recursive: true, force: true })),
)
const run = (home: string, args: string[], mode: string) => Effect.gen(function* () {
  const proc = Bun.spawn([process.execPath, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), EMPTY_VESSEL_HOME: join(home, ".empty-vessel"), EMPTY_VESSEL_NATIVE_AUTH_TEST: "1", EMPTY_VESSEL_NATIVE_AUTH_MODE: mode, NO_COLOR: "1" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  })
  const [out, err, code] = yield* Effect.promise(() => Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])).pipe(Effect.ensuring(Effect.sync(() => { if (proc.exitCode === null) proc.kill() })))
  return { output: out + err, code }
}).pipe(Effect.timeout("20 seconds"))
const cli = (home: string, args: string[]) => run(home, ["--preload", fixture, "src/main.ts", ...args], "cli")
const fixturePassed = (result: { output: string; code: number }) => {
  expect(result.output).toMatch(/\b[1-9]\d* pass\b/)
  expect(result.output).not.toMatch(/\b[1-9]\d* fail\b/)
  expect(result.code).toBe(0)
}

test("native Codex auth exercises the complete model wire path with isolated fake HTTP", () => Effect.runPromise(isolated((home) => Effect.gen(function* () {
  fixturePassed(yield* run(home, ["test", fixture], "model"))
}))), 30_000)

test("Codex CLI status, help, and logout need no Config and preserve the legacy login", () => Effect.runPromise(isolated((home) => Effect.gen(function* () {
  const native = join(home, ".empty-vessel/providers/codex.json")
  const legacy = join(home, ".codex/auth.json")
  const legacyBefore = readFileSync(legacy, "utf8")
  const config = join(home, ".empty-vessel/config.json")
  const configBefore = readFileSync(config, "utf8")

  const fallback = yield* cli(home, ["login", "codex", "--status"])
  expect(fallback.code).toBe(0)
  expect(fallback.output).toMatch(/read-only.*Codex CLI/i)
  writeFileSync(native, JSON.stringify({ version: 1, credentials: { access: "native-access-secret", refresh: "native-refresh-secret", expires: Date.now() + 3_600_000, accountId: "native-account" } }))
  const status = yield* cli(home, ["login", "codex", "--status"])
  expect(status.code).toBe(0)
  expect(status.output).toMatch(/independent.*login/i)
  expect(status.output).not.toMatch(/native-access-secret|native-refresh-secret|legacy-refresh-secret/)

  for (const args of [["--help"], ["login", "--help"], ["logout", "--help"]]) {
    const help = yield* cli(home, args)
    expect(help.code).toBe(0)
    expect(help.output).toMatch(/USAGE|Usage/)
  }

  const logout = yield* cli(home, ["logout", "codex"])
  expect(logout.code).toBe(0)
  expect(logout.output).toMatch(/logged out/i)
  expect(JSON.parse(readFileSync(native, "utf8"))).toEqual({ version: 1, credentials: null })
  fixturePassed(yield* run(home, ["test", fixture], "logged-out"))
  const after = yield* cli(home, ["login", "codex", "--status"])
  expect(after.code).toBe(0)
  expect(after.output).toMatch(/not logged in/i)
  expect(readFileSync(legacy, "utf8")).toBe(legacyBefore)
  expect(readFileSync(config, "utf8")).toBe(configBefore)
}))), 120_000)

test("Codex CLI auth errors exit nonzero without loading malformed Config", () => Effect.runPromise(isolated((home) => Effect.gen(function* () {
  const legacy = join(home, ".codex/auth.json")
  const before = readFileSync(legacy, "utf8")
  writeFileSync(join(home, ".empty-vessel/providers/codex.json"), "{broken native credentials")
  const malformed = yield* cli(home, ["login", "codex", "--status"])
  expect(malformed.code).not.toBe(0)
  expect(malformed.output).toMatch(/Codex credentials/i)
  expect(malformed.output).not.toMatch(/ConfigError/)

  const conflicting = yield* cli(home, ["login", "codex", "--status", "--device-code"])
  expect(conflicting.code).not.toBe(0)
  expect(conflicting.output).toMatch(/either.*--status.*--device-code/i)
  const unsupported = yield* cli(home, ["logout", "unsupported-provider"])
  expect(unsupported.code).not.toBe(0)
  expect(unsupported.output).toMatch(/logout codex/)
  expect(readFileSync(legacy, "utf8")).toBe(before)
}))), 60_000)
