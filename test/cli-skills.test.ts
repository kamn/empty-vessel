import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { CORE_VERSION } from "../src/base/version"

const folders: string[] = []
afterAll(() => { for (const folder of folders) rmSync(folder, { recursive: true, force: true }) })
const main = resolve(import.meta.dir, "../src/main.ts")
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("EMPTY_VESSEL_")))
const fixture = (provider?: "stop" | "error") => {
  const root = mkdtempSync(join(tmpdir(), "cli-skills-"))
  folders.push(root)
  const home = join(root, "home"), project = join(root, "project")
  mkdirSync(home); mkdirSync(project)
  writeFileSync(join(home, "config.json"), JSON.stringify({ ui: "plain", testOptions: true, learnAfterTurn: false,
    systemOne: { use: "fake" }, systemTwo: { use: "fake", scopeCheck: false }, maxSteps: 1 }))
  const add = (name: string, fields = "") => {
    const dir = join(project, ".empty-vessel", "skills", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: CLI ${name}\n${fields}---\nFULL_SKILL_BODY: reason about $ARGUMENTS.\n`)
    return join(dir, "SKILL.md")
  }
  if (provider) {
    const plugin = join(root, "provider.ts")
    const sourcePath = (path: string) => JSON.stringify(resolve(import.meta.dir, "../src", path))
    writeFileSync(plugin, `
import { Effect, Layer } from "effect"
import { SystemTwo } from ${sourcePath("system-two/systemtwo.ts")}
import { FakeFill } from ${sourcePath("system-two/fill.ts")}
import { FakeAsk } from ${sourcePath("system-two/ask.ts")}
export default { name: "skilltest", core: ${JSON.stringify(CORE_VERSION)}, provides: {
  systemTwo: Effect.succeed({ describe: { long: "skilltest", short: "skilltest" }, fill: FakeFill, ask: FakeAsk,
    systemTwo: Layer.succeed(SystemTwo, {
      ask: () => ${provider === "stop" ? 'Effect.sync(() => process.emit("SIGINT")).pipe(Effect.andThen(Effect.never))' : 'Effect.die("SKILL_PROVIDER_FAILED")'},
      compact: () => Effect.die("unexpected compaction"),
    }),
  }),
} }
`)
    const configFile = join(home, "config.json")
    const config = JSON.parse(readFileSync(configFile, "utf8"))
    config.systemTwo.use = "skilltest"
    config.plugins = { skilltest: { path: plugin } }
    writeFileSync(configFile, JSON.stringify(config))
  }
  const source = add("explain")
  const run = (input: string, interactive = false) => {
    const child = Bun.spawnSync(["bun", main, ...(interactive ? [] : ["--prompt", input])], {
      cwd: project, env: { ...cleanEnv, EMPTY_VESSEL_HOME: home, NO_COLOR: "1" },
      stdin: interactive ? new TextEncoder().encode(input + "\n/exit\n") : "ignore",
      stdout: "pipe", stderr: "pipe", timeout: 15_000,
    })
    const output = child.stdout.toString() + child.stderr.toString()
    const sessions = join(home, "sessions")
    const entries = existsSync(sessions) ? readdirSync(sessions).flatMap(id => {
      const file = join(sessions, id, "main.jsonl")
      return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)) : []
    }) : []
    return { output, entries, exitCode: child.exitCode }
  }
  return { add, run, source, root, project }
}

for (const interactive of [false, true]) {
  const mode = interactive ? "interactive" : "--prompt"
  for (const command of ["/explain detailed arguments", "/skill explain detailed arguments"]) {
    test(`${mode} activates ${command} through the real CLI`, () => {
      const f = fixture()
      const result = f.run(command, interactive)
      expect(result.exitCode).toBe(0)
      const skills = result.entries.filter(e => e.role === "skill")
      expect(skills).toHaveLength(1)
      expect(skills[0].text).toBe("explain")
      expect(skills[0].content).toContain("FULL_SKILL_BODY")
      expect(skills[0].content).toContain("detailed arguments")
      expect(skills[0].content).toContain(f.source)
      expect(result.output).toContain("System Two would think about")
      expect(result.output).toContain(skills[0].content)
      expect(result.entries.some(e => e.role === "step" && e.text.includes("escalate"))).toBe(true)
    })
  }
  for (const command of ["/skills", "/skills reload"]) {
    test(`${mode} ${command} stays local`, () => {
      const result = fixture().run(command, interactive)
      expect(result.exitCode).toBe(0)
      expect(result.output).toContain("explain")
      expect(result.entries.filter(e => ["skill", "step", "decision", "user"].includes(e.role))).toEqual([])
      expect(result.output).not.toContain("System Two would think about")
    })
  }
  test(`${mode} invalid explicit skills fail without a model turn`, () => {
    const result = fixture().run("/skill missing", interactive)
    expect(result.output).toContain("missing")
    expect(result.entries.filter(e => ["skill", "step", "decision", "user"].includes(e.role))).toEqual([])
  })
}

test("interactive built-in prefixes do not swallow hyphenated skills and explicit routing resets", () => {
  const f = fixture()
  const names = ["flag-check", "memory-check", "refine-check", "model-check", "agent-check"]
  for (const name of names) f.add(name)
  const result = f.run([...names.map(name => `/${name}`), "ordinary followup"].join("\n"), true)
  expect(result.exitCode).toBe(0)
  expect(result.entries.filter(e => e.role === "skill").map(e => e.text)).toEqual(names)
  expect(result.entries.filter(e => e.role === "flag")).toEqual([])
  expect(result.output).toContain("echo: ordinary followup")
})

test("interactive /flag remains local with whitespace or end", () => {
  const result = fixture().run("/flag\n/flag note", true)
  expect(result.exitCode).toBe(0)
  expect(result.entries.filter(e => e.role === "flag").map(e => e.text)).toEqual(["", "note"])
  expect(result.entries.filter(e => e.role === "step")).toEqual([])
})

for (const interactive of [false, true]) {
  test(`${interactive ? "interactive" : "--prompt"} skill interruption cleans up and stops normally`, () => {
    const f = fixture("stop")
    const result = f.run(interactive ? "/explain\nordinary followup" : "/explain", interactive)
    expect(result.exitCode).toBe(0)
    expect(result.entries.filter(e => e.role === "skill")).toHaveLength(1)
    expect(result.output).toContain("(stopped)")
    if (interactive) expect(result.output).toContain("echo: ordinary followup")
  })
  test(`${interactive ? "interactive" : "--prompt"} provider errors do not silently fall back to System One`, () => {
    const result = fixture("error").run("/explain", interactive)
    expect(result.entries.filter(e => e.role === "skill")).toHaveLength(1)
    expect(result.output).toContain("SKILL_PROVIDER_FAILED")
    expect(result.output).not.toContain("echo: /explain")
  })
}

for (const interactive of [false, true]) {
  test(`${interactive ? "interactive" : "--prompt"} imports a local package without a model turn`, () => {
    const f = fixture()
    const source = join(f.root, "incoming package")
    mkdirSync(join(source, "references"), { recursive: true })
    const instructions = "---\nname: imported-cli\ndescription: Imported CLI test\n---\nFollow references/check.md\n"
    writeFileSync(join(source, "SKILL.md"), instructions)
    writeFileSync(join(source, "references/check.md"), "Supporting instructions")
    const command = `/skills import "${source}" --scope project`
    const result = f.run(command, interactive)
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Imported imported-cli")
    expect(result.entries.some(entry => entry.role === "step" || entry.role === "skill")).toBe(false)
    const target = join(f.project, ".empty-vessel/skills/imported-cli")
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(instructions)
    expect(readFileSync(join(source, "SKILL.md"), "utf8")).toBe(instructions)
    expect(readFileSync(join(target, "references/check.md"), "utf8")).toBe("Supporting instructions")
    expect(existsSync(join(target, ".empty-vessel-import.json"))).toBe(true)
    expect(f.run("/skills", interactive).output).toContain("imported-cli")
    expect(f.run(command, interactive).output).not.toContain("Imported imported-cli")
  })
}
