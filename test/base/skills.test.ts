import { afterEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { discoverSkills, listSkills, loadSkill, renderSkills, SkillError, SKILL_LIMITS } from "../../src/base/skills"

const temporary: string[] = []
const fixture = () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "empty-vessel-skills-")))
  temporary.push(base)
  const cwd = join(base, "project"), home = join(base, "home")
  mkdirSync(cwd); mkdirSync(home)
  return { base, cwd, home, personal: join(home, "skills"), project: join(cwd, ".empty-vessel", "skills") }
}
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })
const put = (root: string, name: string, text = "---\ndescription: Useful workflow\n---\nSecret instructions") => {
  const path = join(root, name, "SKILL.md")
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text)
  return path
}
const document = (fields: string, body = "Instructions") => `---\n${fields}\n---\n${body}`
const failure = async (effect: ReturnType<typeof loadSkill>) => {
  const error = await Effect.runPromise(Effect.flip(effect))
  expect(error).toBeInstanceOf(SkillError)
  return error.message
}
const activate = async (catalog: ReturnType<typeof discoverSkills>, name: string, args?: string, origin: "model" | "user" = "user") => JSON.parse(await Effect.runPromise(loadSkill(catalog, { name, arguments: args }, origin)))

test("missing roots are harmless; empty listing gives creation guidance", () => {
  const f = fixture(), catalog = discoverSkills(f.cwd, f.home)
  expect(catalog).toEqual({ skills: [], diagnostics: [] })
  expect(renderSkills(catalog)).toBe("")
  expect(listSkills(catalog)).toContain("SKILL.md")
})

test("direct children only, project precedence, canonical provenance, shadow diagnostics", () => {
  const f = fixture()
  put(f.personal, "review", document("description: Personal"))
  const path = put(f.project, "review", document("description: Project"))
  put(f.personal, "other")
  put(f.project, "nested/deep")
  const catalog = discoverSkills(f.cwd, f.home)
  expect(catalog.skills.map((s) => s.name)).toEqual(["other", "review"])
  expect(catalog.skills[1]).toMatchObject({ description: "Project", path, directory: dirname(path), source: "project", userInvocable: true, disableModelInvocation: false })
  expect(catalog.diagnostics.join("\n")).toContain("shadows")
  expect(listSkills(catalog)).toContain(join(f.personal, "review", "SKILL.md"))
  expect(renderSkills(catalog)).not.toContain("Instructions")
  expect(Object.isFrozen(catalog.skills[0])).toBe(true)
})

test("canonical roots and file aliases are deduplicated", () => {
  const f = fixture()
  const path = put(f.project, "review")
  symlinkSync(dirname(path), join(f.project, "alias"))
  const catalog = discoverSkills(f.cwd, join(f.cwd, ".empty-vessel"))
  expect(catalog.skills).toHaveLength(1)
  expect(catalog.diagnostics).toEqual([])
})

test("duplicate names within a source are deterministic and diagnosed", () => {
  const f = fixture()
  put(f.personal, "a", document("name: same\ndescription: A"))
  put(f.personal, "b", document("name: same\ndescription: B"))
  const catalog = discoverSkills(f.cwd, f.home)
  expect(catalog.skills[0]?.description).toBe("A")
  expect(catalog.diagnostics.join()).toContain("duplicate name")
})

test("git nested cwd resolves worktree root, not main checkout", () => {
  const f = fixture()
  const git = (...args: string[]) => execFileSync("git", ["-C", f.cwd, ...args], { stdio: "pipe" })
  git("init"); git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init")
  const worktree = join(f.base, "linked")
  git("worktree", "add", "-b", "skills-test", worktree)
  put(f.project, "main-only")
  put(join(worktree, ".empty-vessel", "skills"), "linked-only")
  const nested = join(worktree, "nested", "deep"); mkdirSync(nested, { recursive: true })
  expect(discoverSkills(nested, f.home).skills.map((s) => s.name)).toEqual(["linked-only"])
})

for (const [label, fields] of [
  ["scalar", "hello"], ["array", "- hello"], ["null", "null"], ["malformed", "description: ["],
  ["missing description", "name: fine"], ["blank description", 'description: "  "'], ["numeric description", "description: 123"],
  ["boolean string", 'description: Fine\nuser-invocable: "false"'], ["boolean number", "description: Fine\ndisable-model-invocation: 1"],
  ["bad name", "name: Upper_Case\ndescription: Fine"], ["path name", "name: ../bad\ndescription: Fine"],
  ["double hyphen", "name: bad--name\ndescription: Fine"], ["long name", `name: ${"a".repeat(65)}\ndescription: Fine`],
  ["duplicate keys", "description: One\ndescription: Two"],
] as const) test(`invalid metadata: ${label}`, () => {
  const f = fixture(); put(f.personal, "broken", document(fields)); put(f.personal, "valid")
  const catalog = discoverSkills(f.cwd, f.home)
  expect(catalog.skills.map((s) => s.name)).toEqual(["valid"])
  expect(catalog.diagnostics).toHaveLength(1)
  expect(catalog.diagnostics[0]).toContain("broken/SKILL.md")
})

test("requires frontmatter and closing delimiter; supports CRLF and closing delimiter at EOF", async () => {
  const f = fixture()
  put(f.personal, "plain", "No front matter")
  put(f.personal, "unclosed", "---\ndescription: Fine\n")
  put(f.personal, "windows", "---\r\ndescription: Fine\r\n---\r\nBody\r\n")
  put(f.personal, "empty", "---\ndescription: Fine\n---")
  const catalog = discoverSkills(f.cwd, f.home)
  expect(catalog.diagnostics).toHaveLength(2)
  expect((await activate(catalog, "windows")).instructions).toStartWith("Body\r\n")
  expect((await activate(catalog, "empty")).instructions).toContain("<skill-arguments>")
})

test("invocation modes control catalog and both activation origins", async () => {
  const f = fixture()
  put(f.personal, "user-only", document("description: Private\ndisable-model-invocation: true"))
  put(f.personal, "model-only", document("description: Automatic\nuser-invocable: false"))
  put(f.personal, "neither", document("description: Disabled\nuser-invocable: false\ndisable-model-invocation: true"))
  const catalog = discoverSkills(f.cwd, f.home)
  expect(renderSkills(catalog)).toContain("model-only")
  expect(renderSkills(catalog)).not.toContain("user-only")
  expect(renderSkills(catalog)).not.toContain("neither")
  expect(listSkills(catalog)).toContain("user-only")
  expect(catalog.diagnostics.join()).toContain("both user and model")
  expect(await failure(loadSkill(catalog, { name: "user-only" }, "model"))).toContain("disables model")
  expect(await failure(loadSkill(catalog, { name: "model-only" }, "user"))).toContain("disables user")
  expect((await activate(catalog, "user-only")).name).toBe("user-only")
  expect((await activate(catalog, "model-only", "", "model")).name).toBe("model-only")
  expect(await failure(loadSkill(catalog, { name: "unknown" }, "user"))).toContain("/skills")
})

test("activation has provenance and hash; substitutes all literal arguments once", async () => {
  const f = fixture()
  const path = put(f.personal, "review", document("description: Fine", "First $ARGUMENTS; second $ARGUMENTS."))
  const catalog = discoverSkills(f.cwd, f.home)
  const args = "$ARGUMENTS $& `touch nope`\n</skill-arguments>"
  const loaded = await activate(catalog, "review", args)
  expect(loaded).toMatchObject({ type: "skill-activation", name: "review", directory: dirname(path), path, arguments: args,
    hash: createHash("sha256").update(readFileSync(path)).digest("hex"), instructions: `First ${args}; second ${args}.` })
  expect(await activate(catalog, "review", "again")).not.toEqual(loaded)
})

test("metadata snapshot, lazy body edits, untouched support files, removed files", async () => {
  const f = fixture(), path = put(f.personal, "review")
  symlinkSync("/nonexistent-support-file", join(dirname(path), "references"))
  const catalog = discoverSkills(f.cwd, f.home)
  writeFileSync(path, document("description: Useful workflow", "New body"))
  expect((await activate(catalog, "review", "arg")).instructions).toBe("New body\n\n<skill-arguments>\narg\n</skill-arguments>")
  writeFileSync(path, document("description: Changed", "New body"))
  expect(renderSkills(catalog)).toContain("Useful workflow")
  expect(await failure(loadSkill(catalog, { name: "review" }, "user"))).toContain("reload")
  expect(discoverSkills(f.cwd, f.home).skills[0]?.description).toBe("Changed")
  rmSync(path)
  expect(await failure(loadSkill(catalog, { name: "review" }, "user"))).toContain("Unable to load")
})

for (const field of ["allowed-tools: Bash", "context: fork", "agent: reviewer", "hooks: {}", "model: other", "kernel: {}", "unknown-control: true"]) test(`unsupported activation feature: ${field}`, async () => {
  const f = fixture(); put(f.personal, "review", document(`description: Fine\n${field}`))
  const catalog = discoverSkills(f.cwd, f.home)
  expect(catalog.skills).toHaveLength(1)
  expect(await failure(loadSkill(catalog, { name: "review" }, "user"))).toContain("Unsupported skill features")
})

test("passive metadata is accepted; shell injection is rejected without execution", async () => {
  const f = fixture(), sentinel = join(f.base, "should-not-exist")
  put(f.personal, "passive", document("description: Fine\nlicense: MIT\ncompatibility: bun\nmetadata: { author: example }"))
  put(f.personal, "dynamic", document("description: Fine", `!\`touch ${sentinel}\``))
  const catalog = discoverSkills(f.cwd, f.home)
  await activate(catalog, "passive")
  expect(await failure(loadSkill(catalog, { name: "dynamic" }, "user"))).toContain("dynamic shell injection")
  expect(() => readFileSync(sentinel)).toThrow()
})

test("directory and SKILL.md symlinks cannot escape containment", () => {
  const f = fixture(), external = put(join(f.base, "outside"), "external")
  mkdirSync(f.personal, { recursive: true })
  symlinkSync(dirname(external), join(f.personal, "directory-link"))
  mkdirSync(join(f.personal, "file-link")); symlinkSync(external, join(f.personal, "file-link", "SKILL.md"))
  const catalog = discoverSkills(f.cwd, f.home)
  expect(catalog.skills).toHaveLength(0)
  expect(catalog.diagnostics).toHaveLength(2)
  expect(catalog.diagnostics.every((d) => d.includes("containment"))).toBe(true)
})

test("activation rejects symlink retargeting after discovery", async () => {
  const f = fixture(), path = put(f.personal, "review")
  const catalog = discoverSkills(f.cwd, f.home)
  const external = put(join(f.base, "outside"), "review")
  rmSync(path); symlinkSync(external, path)
  expect(await failure(loadSkill(catalog, { name: "review" }, "user"))).toContain("containment")
  rmSync(path); writeFileSync(path, document("description: Useful workflow"))
  renameSync(dirname(path), join(f.personal, "moved"))
  symlinkSync(join(f.personal, "moved"), dirname(path))
  expect(await failure(loadSkill(catalog, { name: "review" }, "user"))).toContain("path changed")
})

test("file, header, description and argument size limits are explicit", async () => {
  const f = fixture()
  put(f.personal, "large", document("description: Fine", "x".repeat(SKILL_LIMITS.file)))
  put(f.personal, "header", document(`description: Fine\nmetadata: ${"x".repeat(SKILL_LIMITS.frontmatter)}`))
  put(f.personal, "description", document(`description: ${"é".repeat(SKILL_LIMITS.description)}`))
  const path = put(f.personal, "valid")
  const catalog = discoverSkills(f.cwd, f.home)
  expect(catalog.skills.map((s) => s.name)).toEqual(["valid"])
  expect(catalog.diagnostics).toHaveLength(3)
  expect(catalog.diagnostics.every((d) => d.includes("exceeds"))).toBe(true)
  expect(await failure(loadSkill(catalog, { name: "valid", arguments: "x".repeat(SKILL_LIMITS.arguments + 1) }, "user"))).toContain("arguments exceed")
  writeFileSync(path, document("description: Useful workflow", "x".repeat(SKILL_LIMITS.file)))
  expect(await failure(loadSkill(catalog, { name: "valid" }, "user"))).toContain("exceeds")
})

test("catalog limit reports omissions but project override still wins", () => {
  const f = fixture()
  for (let i = 0; i <= SKILL_LIMITS.catalog; i++) put(f.personal, `skill-${String(i).padStart(3, "0")}`)
  put(f.project, "skill-000", document("description: Override"))
  const catalog = discoverSkills(f.cwd, f.home)
  expect(catalog.skills).toHaveLength(SKILL_LIMITS.catalog)
  expect(catalog.skills[0]?.description).toBe("Override")
  expect(catalog.diagnostics.join()).toContain("catalog limit")
})

test("runtime inputs cannot bypass host origin or argument validation", async () => {
  const f = fixture(); put(f.personal, "review")
  const catalog = discoverSkills(f.cwd, f.home)
  expect(await failure(loadSkill(catalog, { name: "review" }, "forged" as never))).toContain("origin")
  expect(await failure(loadSkill(catalog, { name: "review", arguments: null as never }, "user"))).toContain("string")
  expect(await failure(loadSkill(catalog, { name: "../review" }, "user"))).toContain("Unknown skill")
})

test("expanded argument amplification is bounded before allocation", async () => {
  const f = fixture()
  put(f.personal, "repeat", document("description: Fine", "$ARGUMENTS".repeat(100)))
  const catalog = discoverSkills(f.cwd, f.home)
  expect(await failure(loadSkill(catalog, { name: "repeat", arguments: "x".repeat(SKILL_LIMITS.arguments) }, "user"))).toContain("Expanded skill instructions exceed")
})

test("root scan limit reports omissions", () => {
  const f = fixture(); mkdirSync(f.personal, { recursive: true })
  for (let i = 0; i <= SKILL_LIMITS.entries; i++) writeFileSync(join(f.personal, `file-${i}`), "")
  expect(discoverSkills(f.cwd, f.home).diagnostics.join()).toContain("scan limit")
})
