import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { Config, ConfigSchema } from "../src/base/config"
import { guardPreview } from "../src/guard-preview"
import { ActionGuard, evaluateAction } from "../src/tools/action-guard"
import { AskUser } from "../src/ui/ask"

const home = mkdtempSync(join(tmpdir(), "empty-vessel-guard-preview-"))
afterAll(() => rmSync(home, { recursive: true, force: true }))
const config = Schema.decodeUnknownSync(ConfigSchema)({})
const run = (args: Parameters<typeof guardPreview>[0]) => Effect.runPromise(guardPreview(args).pipe(Effect.provideService(Config, config)))
const cli = (...args: string[]) => Bun.spawnSync(["bun", "src/main.ts", "guard", ...args], {
  cwd: join(import.meta.dir, ".."), env: { ...process.env, EMPTY_VESSEL_HOME: home }, stdout: "pipe", stderr: "pipe",
})

test("preview reports unconfigured default allow without executing", async () => {
  const marker = join(home, "not-created")
  const result = await run({ command: `touch '${marker}'` })
  expect(result).toMatchObject({ mode: "dry-run", executed: false, policies: [], verdict: { decision: "allow" } })
  expect(result.note).toContain("No guards selected")
  expect(existsSync(marker)).toBe(false)
})

test("preview selects the bundled policy without saving configuration", async () => {
  // The rejected operand is a nonexistent path under this test's temporary folder.
  const command = `rm -rf '${join(home, "absent")}'`
  const result = await run({ command, policy: "no-absolute-rm", timeoutSeconds: 7 })
  expect(result).toMatchObject({ executed: false, policies: ["no-absolute-rm"], verdict: { decision: "deny" } })
  expect(result.action).toEqual({ kind: "shell", command, cwd: process.cwd(), timeoutMs: 7000 })
  expect(config.actionGuard.use).toEqual([])
  expect(existsSync(join(home, "config.json"))).toBe(false)
})

test("policy evaluation reports ask without asking a human", async () => {
  let asked = false
  const verdict = await Effect.runPromise(evaluateAction({ kind: "shell", command: "echo hi", cwd: process.cwd(), timeoutMs: 1000 }).pipe(
    Effect.provideService(ActionGuard, { beforeAction: () => Effect.succeed({ decision: "ask", reason: "Approval required" }) }),
    Effect.provideService(AskUser, { ask: () => Effect.sync(() => { asked = true; return [] }) }),
  ))
  expect(verdict).toEqual({ decision: "ask", reason: "Approval required" })
  expect(asked).toBe(false)
})

for (const timeoutSeconds of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
  test(`preview rejects invalid timeout ${timeoutSeconds}`, async () => {
    await expect(run({ command: "echo hi", timeoutSeconds })).rejects.toThrow("positive integer timeout")
  })
}

test("preview rejects empty command, unknown policy and misdirected prompt", async () => {
  await expect(run({ command: "   " })).rejects.toThrow("nonempty command")
  await expect(run({ command: "echo hi", policy: "missing-policy" })).rejects.toThrow("actionGuard.use")
  await expect(run({ command: "echo hi", policy: "no-absolute-rm", prompt: "Allow" })).rejects.toThrow("--policy-prompt requires jev-guard")
})

test("CLI dry-run is JSON, does not execute, and does not start an agent or write config", () => {
  const marker = join(home, "cli-not-created")
  const output = cli("--policy", "no-absolute-rm", "--command", `touch '${marker}'`)
  expect(output.exitCode).toBe(0)
  expect(JSON.parse(output.stdout.toString())).toMatchObject({ mode: "dry-run", executed: false, policies: ["no-absolute-rm"], verdict: { decision: "allow" } })
  expect(existsSync(marker)).toBe(false)
  expect(existsSync(join(home, "config.json"))).toBe(false)
  expect(existsSync(join(home, "sessions"))).toBe(false)
})

test("CLI returns failure for invalid policy configuration", () => {
  const output = cli("--policy", "missing-policy", "--command", "echo hi")
  expect(output.exitCode).not.toBe(0)
  expect(output.stderr.toString() + output.stdout.toString()).toContain("actionGuard.use")
})
