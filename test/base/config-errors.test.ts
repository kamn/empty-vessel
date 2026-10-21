import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// A fresh process per case: the config's file and home are read when the module loads. Only Config is loaded.
const load = (config: string, env: Record<string, string> = {}) => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-config-"))
  writeFileSync(join(home, "config.json"), config)
  const script = `import { Effect } from "effect"; import { Config } from ${JSON.stringify(resolve("src/base/config.ts"))}
    Effect.runPromise(Effect.flip(Effect.provide(Config, Config.layer))).then((e) => console.log(e._tag + ": " + e.message), (d) => console.log("DEFECT " + d))`
  const r = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, EMPTY_VESSEL_HOME: home, ...env }, stdout: "pipe", stderr: "pipe" })
  return r.stdout.toString().trim()
}

test("bad settings are a ConfigError that says what's wrong, not a crash", () => {
  expect(load("null")).toContain("ConfigError: ")
  expect(load("null")).toContain("must be a JSON object")
  expect(load("{}", { EMPTY_VESSEL_ADOPTION: "{not json" })).toStartWith("ConfigError: EMPTY_VESSEL_ADOPTION")
})

test("recentNotes skips a torn line instead of failing", () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-notes-")), root = mkdtempSync(join(tmpdir(), "empty-vessel-root-"))
  const script = `import { Effect } from "effect"; import { projectDir } from ${JSON.stringify(resolve("src/base/project.ts"))}; import { recentNotes } from ${JSON.stringify(resolve("src/learning/notes.ts"))}; import { mkdirSync, writeFileSync } from "node:fs"
    const dir = projectDir(${JSON.stringify(root)}); mkdirSync(dir, { recursive: true })
    writeFileSync(dir + "/notes.jsonl", JSON.stringify({ kind: "open", text: "one" }) + "\\n" + '{"kind":"op' + "\\n")
    Effect.runPromise(recentNotes(${JSON.stringify(root)})).then((n) => console.log(JSON.stringify(n)), (e) => console.log("FAILED " + e))`
  const r = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, EMPTY_VESSEL_HOME: home }, stdout: "pipe", stderr: "pipe" })
  expect(r.stdout.toString().trim()).toBe(JSON.stringify([{ kind: "open", text: "one" }]))
})
