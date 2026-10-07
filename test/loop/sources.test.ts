import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addSource, describeSources, entryFor, loadLogin, removeSource, saveLogin } from "../../src/loop/sources"

test("sources add / remove keep the rest of the config as it is, and the file readable only by the user", () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-"))
  const file = join(home, "config.json")
  writeFileSync(file, JSON.stringify({ systemOne: { use: "jev", apiKey: "secret-key" }, ui: "tui" }))

  addSource(file, "posthog", entryFor("https://mcp.posthog.com/mcp", { oauth: true }))
  addSource(file, "files", entryFor("npx -y @modelcontextprotocol/server-filesystem /tmp"))
  const config = JSON.parse(readFileSync(file, "utf8"))
  expect(config.systemOne).toEqual({ use: "jev", apiKey: "secret-key" }) // untouched
  expect(config.ui).toBe("tui")
  expect(config.sources).toEqual({
    posthog: { url: "https://mcp.posthog.com/mcp", auth: "oauth" },
    files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
  })
  expect(statSync(file).mode & 0o777).toBe(0o600)

  saveLogin("posthog", { resource: "r", clientId: "c", tokenEndpoint: "t", accessToken: "a" }, home)
  expect(removeSource(file, "posthog", home)).toBe(true)
  expect(JSON.parse(readFileSync(file, "utf8")).sources).toEqual({ files: config.sources.files })
  expect(loadLogin("posthog", home)).toBeUndefined() // its login went too
  expect(removeSource(file, "posthog", home)).toBe(false)
  expect(() => addSource(file, "post-hog", entryFor("https://x"))).toThrow("can't be a source name")
})

test("the list shows where each source is and whether it's logged in, never a header's value", () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-"))
  const lines = describeSources({ posthog: { url: "https://mcp.posthog.com/mcp", auth: "oauth" }, api: { url: "https://x/mcp", headers: { authorization: "Bearer secret" } } }, home)
  expect(lines).toEqual(["posthog  https://mcp.posthog.com/mcp  oauth (not logged in: empty-vessel login posthog)", "api  https://x/mcp  headers: authorization"])
  expect(lines.join("")).not.toContain("secret")
})

test("plugin settings: old places are moved into plugins.<name>.config (the new place wins), the environment wins for one run, and a wrong value names its plugin", async () => {
  const { movedIntoPlugins } = await import("../../src/base/config")
  const moved = movedIntoPlugins({ systemOne: { use: "jev", apiKey: "k-old" }, systemTwo: { use: "codex", model: "m-old", claudeModel: "opus" }, plugins: { codex: { config: { model: "m-new" } } } })
  expect(moved).toEqual({
    systemOne: { use: "jev" },
    systemTwo: { use: "codex" },
    plugins: { jev: { config: { apiKey: "k-old" } }, codex: { config: { model: "m-new" } }, claude: { config: { model: "opus" } } },
  })

  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-plugin-config-"))
  writeFileSync(join(dir, "config.json"), JSON.stringify({ systemTwo: { use: "codex" }, plugins: { codex: { config: { model: "from-file" } }, claude: { config: { fillModel: { nested: true } } } } }))
  const run = (script: string, env: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["bun", "-e", script], { cwd: join(import.meta.dir, "../.."), env: { ...process.env, EMPTY_VESSEL_HOME: dir, ...env }, stdout: "pipe", stderr: "pipe" })
    return (r.stdout.toString() + r.stderr.toString()).trim()
  }
  const read = (name: string) => `import { Effect } from "effect"; import { Config } from "./src/base/config"; import { pluginSettings } from "./src/plugins/plugin"; import { SETTINGS } from "./src/plugins/index"
    Effect.runPromise(pluginSettings("${name}", SETTINGS.${name}).pipe(Effect.provide(Config.layer), Effect.map((s) => JSON.stringify(s)), Effect.catch((e) => Effect.succeed("error: " + e.message)))).then(console.log)`
  expect(run(read("codex"))).toBe(`{"model":"from-file","fillModel":"gpt-6-luna"}`)                           // the file, then the default
  expect(run(read("codex"), { EMPTY_VESSEL_CODEX_MODEL: "from-env" })).toContain(`"model":"from-env"`)              // the environment wins
  expect(run(read("claude"))).toContain("error: plugins.claude.config:")                                      // fillModel an object: not text

  // A misspelt setting is an error too, never silently ignored.
  writeFileSync(join(dir, "config.json"), JSON.stringify({ plugins: { codex: { config: { modle: "x" } } } }))
  expect(run(read("codex"))).toContain("error: plugins.codex.config:")
  expect(run(read("codex"))).toContain("modle")
})
