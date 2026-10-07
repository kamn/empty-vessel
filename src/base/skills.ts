import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { Data, Effect } from "effect"
import { EMPTY_VESSEL_HOME } from "./home"

export class SkillError extends Data.TaggedError("SkillError")<{ message: string }> {}

// Byte limits, not JS character limits. Names are 1–64 lowercase alphanumeric characters,
// separated by single hyphens (no leading, trailing or repeated hyphens).
export const SKILL_LIMITS = Object.freeze({ file: 256 * 1024, frontmatter: 16 * 1024, description: 1024, arguments: 32 * 1024, instructions: 512 * 1024, catalog: 128, entries: 1024 })
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const validName = (name: string) => name.length <= 64 && NAME.test(name)
export type Skill = {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly directory: string
  readonly userInvocable: boolean
  readonly disableModelInvocation: boolean
  readonly source: "personal" | "project"
  /** Original entry and canonical root allow activation to detect symlink retargeting. */
  readonly entryPath: string
  readonly root: string
  readonly unsupported: readonly string[]
}
export type SkillCatalog = { readonly skills: readonly Skill[]; readonly diagnostics: readonly string[] }
export type SkillInvocation = { readonly name: string; readonly arguments?: string }
export type SkillOrigin = "model" | "user"
const fail = (message: string): never => { throw new SkillError({ message }) }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const inside = (root: string, path: string) => {
  const part = relative(root, path)
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith("../"))
}
const contained = (root: string, path: string) => {
  const canonical = realpathSync(path)
  if (!inside(root, canonical)) fail(`Path escapes skill containment root: ${path}`)
  return canonical
}
export const skillPaths = (root: string, entryPath: string) => {
  const directory = contained(root, entryPath)
  if (!statSync(directory).isDirectory()) fail(`Not a skill directory: ${entryPath}`)
  const path = contained(directory, join(entryPath, "SKILL.md"))
  return { directory, path }
}

// No shell is involved, and no skill-controlled command is ever run. rev-parse returns
// the current worktree's top level (not the shared Git common directory).
export const projectRoot = (cwd: string) => {
  try {
    return resolve(execFileSync("git", ["-C", resolve(cwd), "rev-parse", "--show-toplevel"], {
      encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"],
    }).trim())
  } catch { return resolve(cwd) }
}

const withFile = <A>(path: string, use: (fd: number) => A): A => {
  // Nonblocking prevents a replaced FIFO from hanging discovery; NOFOLLOW rejects a
  // last-component symlink swapped in after canonicalization.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) fail(`SKILL.md must be a regular file: ${path}`)
    if (stat.size > SKILL_LIMITS.file) fail(`SKILL.md exceeds ${SKILL_LIMITS.file} bytes: ${path}`)
    return use(fd)
  } finally { closeSync(fd) }
}

// Read only through the closing delimiter. Bodies and support files stay unread at discovery.
const frontmatter = (fd: number | Buffer) => {
  const bytes: number[] = []
  const one = Buffer.alloc(1)
  let line: number[] = []
  let first = true
  while (bytes.length <= SKILL_LIMITS.frontmatter) {
    const n = typeof fd === "number" ? readSync(fd, one, 0, 1, bytes.length) : fd.copy(one, 0, bytes.length, bytes.length + 1)
    if (!n) {
      if (!first && Buffer.from(line).toString("utf8").replace(/\r$/, "") === "---") {
        return { yaml: Buffer.from(bytes.slice(0, bytes.length - line.length)).toString("utf8"), offset: bytes.length }
      }
      fail("Missing YAML frontmatter closing --- delimiter")
    }
    bytes.push(one[0]!)
    if (one[0] !== 10) { line.push(one[0]!); continue }
    const text = Buffer.from(line).toString("utf8").replace(/\r$/, "")
    if (first) {
      if (text !== "---") fail("SKILL.md must start with YAML frontmatter (---)")
      first = false
    } else if (text === "---") {
      return { yaml: Buffer.from(bytes.slice(0, bytes.length - line.length - 1)).toString("utf8"), offset: bytes.length }
    }
    line = []
  }
  return fail(`Frontmatter exceeds ${SKILL_LIMITS.frontmatter} bytes`)
}

const parse = (yaml: string, fallback: string) => {
  // Top-level keys use plain, unindented block-mapping syntax. Nested passive
  // metadata and multiline descriptions still use YAML. Bun accepts duplicate keys,
  // so reject duplicates explicitly rather than letting invocation controls be overwritten.
  const source = yaml.replace(/^---\r?\n/, "")
  const keys = new Set<string>()
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || /^\s|^#/.test(line)) continue
    const match = /^([a-z][a-z0-9-]*):(?:\s|$)/.exec(line)
    if (!match) fail("Frontmatter requires plain, unindented top-level YAML mapping keys")
    const key = match![1]!
    if (keys.has(key)) fail(`Duplicate YAML key: ${key}`)
    keys.add(key)
  }
  if (!keys.size) fail("YAML frontmatter must be an object with unindented keys")
  const fields: unknown = Bun.YAML.parse(source)
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) fail("YAML frontmatter must be an object")
  const data = fields as Record<string, unknown>
  const name = data.name === undefined ? fallback : data.name
  if (typeof name !== "string" || !validName(name)) fail("name must be 1–64 lowercase alphanumeric characters separated by single hyphens")
  if (typeof data.description !== "string" || !data.description.trim()) fail("description must be a nonempty string")
  if (Buffer.byteLength(data.description as string) > SKILL_LIMITS.description) fail(`description exceeds ${SKILL_LIMITS.description} bytes`)
  for (const key of ["user-invocable", "disable-model-invocation"]) {
    if (data[key] !== undefined && typeof data[key] !== "boolean") fail(`${key} must be a boolean`)
  }
  // Passive standard metadata is allowed; unknown fields fail activation rather than
  // silently accepting a misspelled control or an execution extension.
  const passive = new Set(["name", "description", "user-invocable", "disable-model-invocation", "license", "compatibility", "metadata"])
  const unsupported = Object.keys(data).filter((key) => !passive.has(key)).sort()
  return {
    name: name as string, description: (data.description as string).trim(),
    userInvocable: data["user-invocable"] !== false,
    disableModelInvocation: data["disable-model-invocation"] === true,
    unsupported: Object.freeze(unsupported),
  }
}

/** Metadata-only reader shared by discovery and same-scope import collision checks. */
export const readSkillMetadata = (path: string, fallback: string) =>
  withFile(path, (fd) => parse(frontmatter(fd).yaml, fallback))

const validateContent = (bytes: Buffer, unsupported: readonly string[]) => {
  if (unsupported.length) fail(`Unsupported skill features: ${unsupported.join(", ")}`)
  if (bytes.length > SKILL_LIMITS.file) fail(`SKILL.md exceeds ${SKILL_LIMITS.file} bytes`)
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (/!`/.test(text)) fail("Unsupported skill feature: dynamic shell injection (!`command`)")
}

/** Installation validates compatibility, not permission to invoke as a particular origin. */
export const validateSkillBytes = (bytes: Buffer, fallback: string) => {
  if (bytes.length > SKILL_LIMITS.file) fail(`SKILL.md exceeds ${SKILL_LIMITS.file} bytes`)
  const metadata = parse(frontmatter(bytes).yaml, fallback)
  validateContent(bytes, metadata.unsupported)
  return metadata
}

export const discoverSkills = (cwd: string, home = EMPTY_VESSEL_HOME): SkillCatalog => {
  const skills = new Map<string, Skill>()
  const diagnostics: string[] = []
  const seenRoots = new Set<string>()
  const seenPaths = new Set<string>()
  const roots = [["personal", join(home, "skills")], ["project", join(projectRoot(cwd), ".empty-vessel", "skills")]] as const
  for (const [source, folder] of roots) {
    let root: string
    let entries: string[]
    try {
      root = realpathSync(folder)
      if (seenRoots.has(root)) continue
      seenRoots.add(root)
      entries = readdirSync(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(`${folder}: ${message(error)}`)
      continue
    }
    const names = entries.sort()
    if (names.length > SKILL_LIMITS.entries) diagnostics.push(`${folder}: scan limit ${SKILL_LIMITS.entries}; omitted ${names.length - SKILL_LIMITS.entries} entries`)
    for (const entry of names.slice(0, SKILL_LIMITS.entries)) {
      const entryPath = join(root, entry)
      try {
        if (!statSync(entryPath).isDirectory()) continue
        const { directory, path } = skillPaths(root, entryPath)
        if (seenPaths.has(path)) continue
        const metadata = readSkillMetadata(path, entry)
        const old = skills.get(metadata.name)
        if (old && old.source === source) {
          diagnostics.push(`${path}: duplicate name ${metadata.name}; retained ${old.path}`)
          continue
        }
        if (!old && skills.size >= SKILL_LIMITS.catalog) {
          diagnostics.push(`${path}: catalog limit ${SKILL_LIMITS.catalog}; skill omitted`)
          continue
        }
        seenPaths.add(path)
        if (old) diagnostics.push(`${path}: shadows ${old.path} (${metadata.name})`)
        if (!metadata.userInvocable && metadata.disableModelInvocation) diagnostics.push(`${path}: both user and model invocation are disabled`)
        skills.set(metadata.name, Object.freeze({ ...metadata, path, directory, source, root, entryPath }))
      } catch (error) { diagnostics.push(`${join(entryPath, "SKILL.md")}: ${message(error)}`) }
    }
  }
  return Object.freeze({ skills: Object.freeze([...skills.values()].sort((a, b) => a.name.localeCompare(b.name))), diagnostics: Object.freeze(diagnostics) })
}

/** Model briefing: metadata only, never bodies or model-disabled entries. */
export const renderSkills = (catalog: SkillCatalog): string => {
  const visible = catalog.skills.filter((skill) => !skill.disableModelInvocation)
  return visible.length ? `Available skills (prefer a relevant skill before improvising a workflow; import skill from "kernel" and activate with skill({ name, arguments? })). Loading returns instructions, not execution. Follow them using existing kernel operations; resolve supporting files against the returned directory, without changing the working directory:\n${visible.map((skill) => `${skill.name}: ${JSON.stringify(skill.description)}`).join("\n")}` : ""
}

export const listSkills = (catalog: SkillCatalog): string => [
  catalog.skills.length ? catalog.skills.map((s) => `${s.name} — ${s.description}\n  ${s.path}\n  user: ${s.userInvocable ? "yes" : "no"}; model: ${s.disableModelInvocation ? "no" : "yes"}`).join("\n") : "No skills found. Create <home>/skills/<name>/SKILL.md or .empty-vessel/skills/<name>/SKILL.md.",
  ...catalog.diagnostics.map((d) => `Diagnostic: ${d}`),
].join("\n")

/** Host supplies origin. Result is a JSON activation envelope, not executable code. */
export const loadSkill = (catalog: SkillCatalog, invocation: SkillInvocation, origin: SkillOrigin): Effect.Effect<string, SkillError> => Effect.try({
  try: () => {
    if (origin !== "model" && origin !== "user") fail("Skill invocation origin must be model or user")
    if (!invocation || typeof invocation.name !== "string") fail("Skill name must be a string")
    const skill = catalog.skills.find((s) => s.name === invocation.name)
    if (!skill) return fail(`Unknown skill ${JSON.stringify(invocation.name)}. Use /skills to list available skills.`)
    if (origin === "model" && skill.disableModelInvocation) fail(`Skill ${skill.name} disables model invocation`)
    if (origin === "user" && !skill.userInvocable) fail(`Skill ${skill.name} disables user invocation`)
    const args = invocation.arguments === undefined ? "" : invocation.arguments
    if (typeof args !== "string") fail("Skill arguments must be a string")
    if (Buffer.byteLength(args) > SKILL_LIMITS.arguments) fail(`Skill arguments exceed ${SKILL_LIMITS.arguments} bytes`)
    const current = skillPaths(skill.root, skill.entryPath)
    if (current.directory !== skill.directory || current.path !== skill.path) fail("Skill path changed; run /skills reload")
    return withFile(skill.path, (fd) => {
      const front = frontmatter(fd)
      const metadata = parse(front.yaml, basename(skill.entryPath))
      for (const key of ["name", "description", "userInvocable", "disableModelInvocation", "unsupported"] as const) {
        if (JSON.stringify(metadata[key]) !== JSON.stringify(skill[key])) fail("Skill metadata changed; run /skills reload")
      }
      if (metadata.unsupported.length) fail(`Unsupported skill features: ${metadata.unsupported.join(", ")}`)
      const buffer = Buffer.alloc(SKILL_LIMITS.file + 1)
      let length = 0
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, length)
        if (!count) break
        length += count
      }
      if (length > SKILL_LIMITS.file) fail(`SKILL.md exceeds ${SKILL_LIMITS.file} bytes`)
      const bytes = buffer.subarray(0, length)
      validateContent(bytes, metadata.unsupported)
      const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(front.offset))
      const occurrences = body.split("$ARGUMENTS").length - 1
      const expandedBytes = Buffer.byteLength(body) + (occurrences ? occurrences * (Buffer.byteLength(args) - 10) : Buffer.byteLength(args) + 40)
      if (expandedBytes > SKILL_LIMITS.instructions) fail(`Expanded skill instructions exceed ${SKILL_LIMITS.instructions} bytes`)
      const instructions = body.includes("$ARGUMENTS")
        ? body.replaceAll("$ARGUMENTS", () => args)
        : `${body}\n\n<skill-arguments>\n${args}\n</skill-arguments>`
      return JSON.stringify({ type: "skill-activation", name: skill.name, directory: skill.directory, path: skill.path,
        hash: createHash("sha256").update(bytes).digest("hex"), arguments: args, instructions }, null, 2)
    })
  },
  catch: (error) => error instanceof SkillError ? error : new SkillError({ message: `Unable to load skill: ${message(error)}` }),
})
