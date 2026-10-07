import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"

// A fixture test run in a child with a temporary HOME holding a fake Codex login (the backend reads ~/.codex/auth.json).
const inChild = (fixture: string) =>
  Effect.runPromise(Effect.acquireUseRelease(
    Effect.sync(() => {
      const home = mkdtempSync(join(tmpdir(), "empty-vessel-question-test-"))
      mkdirSync(join(home, ".codex"))
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")
      writeFileSync(join(home, ".codex/auth.json"), JSON.stringify({ tokens: { access_token: `fake.${payload}.fake`, account_id: "test" } }))
      return home
    }),
    (home) => Effect.gen(function* () {
      const proc = Bun.spawn([process.execPath, "test", fixture], {
        cwd: process.cwd(), env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
      })
      const [out, err, code] = yield* Effect.promise(() => Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]))
      expect(out + err).toContain("1 pass")
      expect(code).toBe(0)
    }),
    (home) => Effect.sync(() => rmSync(home, { recursive: true, force: true })),
  ))

test("Codex interactive questions round-trip using an isolated fake login and HTTP client", () => inChild("./test/fixtures/codex-question.case.ts"))

test("Codex: a final check handed to System One ends the run on a pass, goes back to System Two on a failure", () => inChild("./test/fixtures/codex-finish.case.ts"))
