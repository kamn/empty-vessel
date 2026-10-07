import { afterEach, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { Effect } from "effect"
import { importSkill, SKILL_IMPORT_LIMITS, SKILL_IMPORT_PROVENANCE } from "../../src/base/skill-import"
import { discoverSkills, SkillError } from "../../src/base/skills"

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) fs.rmSync(path, { recursive: true, force: true }) })
const document = (fields = "name: example", body = "Instructions") => `---\ndescription: Useful workflow\n${fields}\n---\n${body}`
const fixture = () => {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "skill-import-")))
  temporary.push(base)
  const cwd = join(base, "project"), home = join(base, "home"), source = join(base, "source with spaces")
  for (const path of [cwd, home, source]) fs.mkdirSync(path)
  fs.writeFileSync(join(source, "SKILL.md"), document())
  return { base, cwd, home, source, folder: join(cwd, ".empty-vessel", "skills") }
}
const run = (f: ReturnType<typeof fixture>, scope: "project" | "personal" = "project", path = f.source) => Effect.runPromise(importSkill({ path, scope }, f.cwd, f.home))
const failure = async (f: ReturnType<typeof fixture>, text: string, path = f.source) => {
  const error = await Effect.runPromise(Effect.flip(importSkill({ path, scope: "project" }, f.cwd, f.home)))
  expect(error).toBeInstanceOf(SkillError)
  expect(error.message).toContain(text)
}

test("copies whole package, preserves bytes/modes, records hashes; never mutates or executes source", async () => {
  const f = fixture()
  for (const folder of ["scripts", "references", "assets", "empty"]) fs.mkdirSync(join(f.source, folder))
  const bytes = Buffer.from([0, 255, 128, 10, 13])
  fs.writeFileSync(join(f.source, "assets", "binary"), bytes)
  fs.writeFileSync(join(f.source, "references", "notes.md"), "reference")
  fs.writeFileSync(join(f.source, "scripts", "run.sh"), `#!/bin/sh\ntouch '${join(f.base, "EXECUTED")}'\n`)
  fs.chmodSync(join(f.source, "scripts", "run.sh"), 0o751)
  fs.chmodSync(join(f.source, "empty"), 0o750)
  const before = fs.readFileSync(join(f.source, "SKILL.md"))
  const result = await run(f, "project", relative(f.cwd, f.source)) // caller has removed shell quotes
  expect(result).toEqual({ name: "example", destination: join(f.folder, "example"), provenance: join(f.folder, "example", SKILL_IMPORT_PROVENANCE) })
  expect(fs.readFileSync(join(result.destination, "assets", "binary"))).toEqual(bytes)
  expect(fs.readFileSync(join(result.destination, "references", "notes.md"), "utf8")).toBe("reference")
  expect(fs.statSync(join(result.destination, "scripts", "run.sh")).mode & 0o777).toBe(0o751)
  expect(fs.statSync(join(result.destination, "empty")).mode & 0o777).toBe(0o750)
  expect(fs.readFileSync(join(f.source, "SKILL.md"))).toEqual(before)
  expect(fs.existsSync(join(f.source, SKILL_IMPORT_PROVENANCE))).toBe(false)
  expect(fs.existsSync(join(f.base, "EXECUTED"))).toBe(false)
  const receipt = JSON.parse(fs.readFileSync(result.provenance, "utf8"))
  expect(receipt).toMatchObject({ name: "example", scope: "project", source: fs.realpathSync(f.source) })
  expect(Number.isNaN(Date.parse(receipt.timestamp))).toBe(false)
  expect(receipt.hashes["SKILL.md"]).toBe(createHash("sha256").update(before).digest("hex"))
  expect(discoverSkills(f.cwd, f.home).skills.map((skill) => skill.name)).toEqual(["example"])
})

for (const fields of ["user-invocable: false", "disable-model-invocation: true", "user-invocable: false\ndisable-model-invocation: true"]) {
  test(`installation ignores invocation permission: ${fields}`, async () => {
    const f = fixture(); fs.writeFileSync(join(f.source, "SKILL.md"), document(`name: example\n${fields}`))
    expect((await run(f)).name).toBe("example")
  })
}
for (const [content, error] of [
  [document("name: example\nallowed-tools: Bash"), "Unsupported skill features"],
  [document("name: example\ncontext: fork"), "Unsupported skill features"],
  [document("name: example", "!`touch EXECUTED`"), "dynamic shell injection"],
  ["not frontmatter", "frontmatter"],
  [document("name: Bad Name"), "name must"],
  [document("name: a\nname: b"), "Duplicate YAML key"],
  [document("name: example\nuser-invocable: 'yes'"), "must be a boolean"],
] as const) {
  test(`rejects before destination writes: ${error} ${content.slice(0, 40)}`, async () => {
    const f = fixture(); fs.writeFileSync(join(f.source, "SKILL.md"), content)
    await failure(f, error)
    expect(fs.existsSync(join(f.cwd, ".empty-vessel"))).toBe(false)
  })
}

test("project root uses git top level from nested cwd; personal home and cross-scope precedence", async () => {
  const f = fixture()
  execFileSync("git", ["init", "-q", f.cwd])
  const nested = join(f.cwd, "deep", "nested"); fs.mkdirSync(nested, { recursive: true })
  const personal = await run(f, "personal")
  expect(personal.destination).toBe(join(f.home, "skills", "example"))
  const project = await Effect.runPromise(importSkill({ path: f.source, scope: "project" }, nested, f.home))
  expect(project.destination).toBe(join(f.folder, "example"))
  expect(discoverSkills(nested, f.home).skills[0]?.source).toBe("project")
})

test("existing destination and broken symlink are never overwritten or removed", async () => {
  const f = fixture(); await run(f)
  await failure(f, "already exists")
  expect(fs.existsSync(join(f.folder, "example", "SKILL.md"))).toBe(true)
  fs.rmSync(join(f.folder, "example"), { recursive: true })
  fs.symlinkSync(join(f.base, "missing"), join(f.folder, "example"))
  await failure(f, "already exists")
  expect(fs.lstatSync(join(f.folder, "example")).isSymbolicLink()).toBe(true)
})

test("same declared name under another folder is rejected, even when invocation disabled", async () => {
  const f = fixture(), installed = join(f.folder, "different-folder")
  fs.mkdirSync(installed, { recursive: true })
  fs.writeFileSync(join(installed, "SKILL.md"), document("name: example\nuser-invocable: false\ndisable-model-invocation: true"))
  await failure(f, "already installed in this scope")
  expect(fs.existsSync(join(f.folder, "example"))).toBe(false)
})

test("rejects URL, missing path, files, missing SKILL.md, directories named SKILL.md, reserved receipt", async () => {
  const f = fixture()
  await failure(f, "local folders only", "https://example.com/skill")
  await failure(f, "ENOENT", join(f.base, "missing"))
  await failure(f, "must be a directory", join(f.source, "SKILL.md"))
  fs.unlinkSync(join(f.source, "SKILL.md")); await failure(f, "regular SKILL.md")
  fs.mkdirSync(join(f.source, "SKILL.md")); await failure(f, "regular SKILL.md")
  fs.writeFileSync(join(f.source, SKILL_IMPORT_PROVENANCE), "reserved")
  await failure(f, "reserved provenance")
  expect(fs.existsSync(f.folder)).toBe(false)
})

for (const target of ["root", "SKILL.md", "asset", "directory", "broken"]) {
  test(`rejects symlinks: ${target}`, async () => {
    const f = fixture()
    if (target === "root") {
      const alias = join(f.base, "alias"); fs.symlinkSync(f.source, alias); await failure(f, "Symlinks", alias)
    } else {
      if (target === "SKILL.md") fs.unlinkSync(join(f.source, target))
      fs.symlinkSync(target === "broken" ? join(f.base, "missing") : target === "directory" ? f.cwd : join(f.base, "target"), join(f.source, target))
      await failure(f, "Symlinks")
    }
    expect(fs.existsSync(f.folder)).toBe(false)
  })
}

test("rejects nonregular FIFO without opening or executing it", async () => {
  const f = fixture(); execFileSync("mkfifo", [join(f.source, "pipe")])
  await failure(f, "regular file or directory")
  expect(fs.existsSync(f.folder)).toBe(false)
})

test("rejects destination nested under source, including symlinked scope roots", async () => {
  const f = fixture()
  fs.writeFileSync(join(f.cwd, "SKILL.md"), document())
  await failure(f, "inside the source", f.cwd)
  fs.mkdirSync(join(f.cwd, ".empty-vessel"))
  fs.symlinkSync(f.source, f.folder)
  await failure(f, "inside the source")
})

test("entry and byte caps reject before writes", async () => {
  const f = fixture()
  for (let i = 0; i < SKILL_IMPORT_LIMITS.entries; i++) fs.writeFileSync(join(f.source, `entry-${i}`), "")
  await failure(f, "1024 entries")
  expect(fs.existsSync(f.folder)).toBe(false)
  for (let i = 0; i < SKILL_IMPORT_LIMITS.entries; i++) fs.unlinkSync(join(f.source, `entry-${i}`))
  fs.writeFileSync(join(f.source, "large"), ""); fs.truncateSync(join(f.source, "large"), SKILL_IMPORT_LIMITS.bytes + 1)
  await failure(f, "64 MiB")
  expect(fs.existsSync(f.folder)).toBe(false)
})

test("failure after exclusive mkdir removes only owned destination; SKILL.md published last", async () => {
  const f = fixture(); fs.writeFileSync(join(f.source, "asset"), "asset")
  const original = fs.writeFileSync
  const mock = spyOn(fs, "writeFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, ...args: any[]) => {
    if (String(path).endsWith(SKILL_IMPORT_PROVENANCE)) {
      expect(fs.existsSync(join(f.folder, "example", "asset"))).toBe(true)
      expect(fs.existsSync(join(f.folder, "example", "SKILL.md"))).toBe(false)
      throw new Error("injected write failure")
    }
    return (original as any)(path, ...args)
  }) as typeof fs.writeFileSync)
  try { await failure(f, "injected write failure") } finally { mock.mockRestore() }
  expect(fs.existsSync(join(f.folder, "example"))).toBe(false)
  expect(fs.readFileSync(join(f.source, "asset"), "utf8")).toBe("asset")
  expect((await run(f)).name).toBe("example")
})

test("scope is mandatory at runtime; folder fallback name uses loader rules", async () => {
  const f = fixture()
  const error = await Effect.runPromise(Effect.flip(importSkill({ path: f.source } as any, f.cwd, f.home)))
  expect(error.message).toContain("scope")
  const source = join(f.base, "fallback-name"); fs.mkdirSync(source)
  fs.writeFileSync(join(source, "SKILL.md"), document("license: MIT"))
  expect((await run(f, "project", source)).name).toBe("fallback-name")
})


test("tilde expands against OS home, not configured application home", async () => {
  const f = fixture()
  const path = `~/${relative((await import("node:os")).homedir(), f.source)}`
  expect((await run(f, "personal", path)).destination).toBe(join(f.home, "skills", "example"))
})

test("exclusive mkdir refuses a destination created after collision checks", async () => {
  const f = fixture(), destination = join(f.folder, "example")
  const original = fs.mkdirSync
  const mock = spyOn(fs, "mkdirSync").mockImplementation(((path: fs.PathLike, options?: any) => {
    if (String(path) === destination) {
      original(destination)
      fs.writeFileSync(join(destination, "KEEP"), "concurrent owner")
    }
    return original(path, options)
  }) as typeof fs.mkdirSync)
  try { await failure(f, "EEXIST") } finally { mock.mockRestore() }
  expect(fs.readFileSync(join(destination, "KEEP"), "utf8")).toBe("concurrent owner")
  expect(fs.existsSync(join(destination, "SKILL.md"))).toBe(false)
})

test("invalid UTF-8 and oversized SKILL.md fail before writes", async () => {
  const f = fixture()
  fs.writeFileSync(join(f.source, "SKILL.md"), Buffer.concat([Buffer.from(document()), Buffer.from([255])]))
  const error = await Effect.runPromise(Effect.flip(importSkill({ path: f.source, scope: "project" }, f.cwd, f.home)))
  expect(error).toBeInstanceOf(SkillError)
  expect(fs.existsSync(f.folder)).toBe(false)
  fs.writeFileSync(join(f.source, "SKILL.md"), document("name: example", "x".repeat(256 * 1024)))
  await failure(f, "SKILL.md exceeds")
  expect(fs.existsSync(f.folder)).toBe(false)
})

test("source siblings are irrelevant and root directory mode is preserved", async () => {
  const f = fixture()
  fs.symlinkSync(join(f.base, "missing"), join(f.base, "unrelated-symlink"))
  fs.chmodSync(f.source, 0o750)
  const result = await run(f)
  expect(fs.statSync(result.destination).mode & 0o777).toBe(0o750)
  expect(fs.lstatSync(join(f.base, "unrelated-symlink")).isSymbolicLink()).toBe(true)
})

test("same-scope collision uses discovery containment for an installed SKILL.md symlink", async () => {
  const f = fixture()
  const installed = join(f.folder, "aaa")
  fs.mkdirSync(installed, { recursive: true })
  fs.writeFileSync(join(installed, "instructions.md"), document("name: example", "Existing instructions"))
  fs.symlinkSync("instructions.md", join(installed, "SKILL.md"))
  expect(discoverSkills(f.cwd, f.home).skills.map(skill => skill.name)).toEqual(["example"])
  await failure(f, "already installed in this scope")
  expect(fs.existsSync(join(f.folder, "example"))).toBe(false)
  expect(fs.readFileSync(join(installed, "instructions.md"), "utf8")).toContain("Existing instructions")
})
