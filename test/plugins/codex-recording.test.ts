import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"

// Import the provider only in the child, after all three homes point at disposable storage.
test("Codex recording uses isolated fake HTTP and disk sessions", () => Effect.runPromise(Effect.acquireUseRelease(
  Effect.sync(() => {
    const home = mkdtempSync(join(tmpdir(), "empty-vessel-recording-test-"))
    mkdirSync(join(home, ".codex"))
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
    writeFileSync(join(home, ".codex/auth.json"), JSON.stringify({ tokens: { access_token: `fake.${payload}.fake`, account_id: "test" } }))
    return home
  }),
  (home) => Effect.gen(function* () {
    const proc = Bun.spawn([process.execPath, "test", "./test/fixtures/codex-recording.case.ts"], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), EMPTY_VESSEL_HOME: join(home, ".empty-vessel"), EMPTY_VESSEL_RECORDING_TEST: "1" },
      stdout: "pipe", stderr: "pipe",
    })
    const [out, err, code] = yield* Effect.promise(() => Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]))
    expect(out + err).toMatch(/\b[1-9]\d* pass\b/)
    expect(out + err).not.toMatch(/\b[1-9]\d* fail\b/)
    expect(code).toBe(0)
  }),
  (home) => Effect.sync(() => rmSync(home, { recursive: true, force: true })),
)), 30_000)
