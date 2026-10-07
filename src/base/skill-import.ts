import { createHash } from "node:crypto"
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { Effect } from "effect"
import { EMPTY_VESSEL_HOME } from "./home"
import { projectRoot, readSkillMetadata, skillPaths, SkillError, validateSkillBytes } from "./skills"

export const SKILL_IMPORT_LIMITS = Object.freeze({ entries: 1024, bytes: 64 * 1024 * 1024 })
export const SKILL_IMPORT_PROVENANCE = ".empty-vessel-import.json"
const fail = (message: string): never => { throw new SkillError({ message }) }
const exists = (path: string) => {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}
const inside = (root: string, path: string) => {
  const part = relative(root, path)
  return part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith("../"))
}
// Resolve existing ancestors too: a scope root may itself be reached through a symlink.
const prospectivePath = (path: string): string => exists(path)
  ? realpathSync(path) : join(prospectivePath(dirname(path)), basename(path))
type Entry = { path: string; mode: number; bytes?: Buffer }

/** Import a local package without executing it. `path` is already unquoted by the caller.
 * Provenance is the absolute path of the JSON receipt. Scope is intentionally required.
 */
export const importSkill = (
  options: { path: string; scope: "project" | "personal" },
  cwd = process.cwd(), home = EMPTY_VESSEL_HOME,
): Effect.Effect<{ name: string; destination: string; provenance: string }, SkillError> => Effect.try({
  try: () => {
    if (!options || (options.scope !== "project" && options.scope !== "personal")) fail("Skill import scope must be project or personal")
    if (typeof options.path !== "string" || !options.path.trim()) fail("Skill import path must be a local folder")
    if (/^[a-z][a-z0-9+.-]*:/i.test(options.path) || options.path.startsWith("//")) fail("Skill import accepts local folders only, not URLs")
    if (options.path.startsWith("~") && options.path !== "~" && !options.path.startsWith("~/")) fail("Only ~ or ~/ paths are supported")
    const input = resolve(cwd, options.path === "~" ? homedir() : options.path.startsWith("~/") ? join(homedir(), options.path.slice(2)) : options.path)
    if (lstatSync(input).isSymbolicLink()) fail(`Symlinks are not allowed in skill imports: ${input}`)
    if (!lstatSync(input).isDirectory()) fail(`Skill import source must be a directory: ${input}`)
    const source = realpathSync(input)
    const sourceMode = lstatSync(source).mode & 0o777
    if (exists(join(source, SKILL_IMPORT_PROVENANCE))) fail(`Source contains reserved provenance file ${SKILL_IMPORT_PROVENANCE}`)
    const entries: Entry[] = []
    let total = 0
    const visit = (directory: string) => {
      const current = join(source, directory)
      if (lstatSync(current).isSymbolicLink() || realpathSync(current) !== current) fail(`Source directory changed or contains a symlink: ${current}`)
      for (const name of readdirSync(join(source, directory)).sort()) {
        if (entries.length >= SKILL_IMPORT_LIMITS.entries) fail(`Skill package exceeds ${SKILL_IMPORT_LIMITS.entries} entries`)
        const path = join(directory, name), absolute = join(source, path), stat = lstatSync(absolute)
        if (stat.isSymbolicLink()) fail(`Symlinks are not allowed in skill imports: ${path}`)
        if (!stat.isDirectory() && !stat.isFile()) fail(`Skill package entry must be a regular file or directory: ${path}`)
        const entry: Entry = { path, mode: stat.mode & 0o777 }
        entries.push(entry)
        if (stat.isDirectory()) { visit(path); continue }
        const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        try {
          const current = fstatSync(fd)
          if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) fail(`Source entry changed while importing: ${path}`)
          if (total + current.size > SKILL_IMPORT_LIMITS.bytes) fail(`Skill package exceeds ${SKILL_IMPORT_LIMITS.bytes} bytes (64 MiB)`)
          const buffer = Buffer.alloc(current.size + 1)
          let length = 0
          while (length < buffer.length) {
            const count = readSync(fd, buffer, length, buffer.length - length, length)
            if (!count) break
            length += count
          }
          if (length !== current.size) fail(`Source file changed size while importing: ${path}`)
          entry.bytes = buffer.subarray(0, length)
          total += length
        } finally { closeSync(fd) }
      }
    }
    visit("")
    const skill = entries.find((entry) => entry.path === "SKILL.md")
    if (!skill?.bytes) return fail("Skill folder must contain a regular SKILL.md file")
    const { name } = validateSkillBytes(skill.bytes, basename(source))
    const folder = resolve(options.scope === "personal" ? join(home, "skills") : join(projectRoot(cwd), ".empty-vessel", "skills"))
    const destination = join(prospectivePath(folder), name)
    if (inside(source, destination)) fail("Skill destination must not be inside the source folder")
    if (exists(destination)) fail(`Skill destination already exists: ${destination}`)
    // Only installed metadata in the selected scope is relevant; never scan source siblings.
    if (exists(folder)) {
      for (const entry of readdirSync(folder)) {
        const installed = join(folder, entry)
        let metadata: ReturnType<typeof readSkillMetadata>
        try {
          if (!statSync(installed).isDirectory()) continue
          const { path } = skillPaths(realpathSync(folder), installed)
          metadata = readSkillMetadata(path, entry)
        } catch { continue } // Malformed folders are not installed skills.
        if (metadata.name === name) fail(`Skill name ${name} is already installed in this scope: ${installed}`)
      }
    }
    const provenance = join(destination, SKILL_IMPORT_PROVENANCE)
    const receipt = JSON.stringify({ source, timestamp: new Date().toISOString(), name, scope: options.scope,
      hashes: Object.fromEntries(entries.filter((entry) => entry.bytes).map((entry) => [entry.path, createHash("sha256").update(entry.bytes!).digest("hex")])) }, null, 2) + "\n"
    mkdirSync(dirname(destination), { recursive: true })
    // Exclusive mkdir: never take ownership of, overwrite, or clean up an existing entry.
    mkdirSync(destination)
    const owned = lstatSync(destination)
    try {
      for (const entry of entries.filter((entry) => !entry.bytes)) mkdirSync(join(destination, entry.path))
      const copy = (entry: Entry) => {
        const target = join(destination, entry.path)
        writeFileSync(target, entry.bytes!, { flag: "wx", mode: entry.mode })
        chmodSync(target, entry.mode)
      }
      for (const entry of entries) if (entry.bytes && entry !== skill) copy(entry)
      writeFileSync(provenance, receipt, { flag: "wx", mode: 0o600 })
      // Publish the loader entry last, after all package files and the receipt exist.
      copy(skill)
      for (const entry of [...entries].reverse()) if (!entry.bytes) chmodSync(join(destination, entry.path), entry.mode)
      chmodSync(destination, sourceMode)
    } catch (error) {
      // Do not remove a different directory if someone replaced ours.
      if (exists(destination)) {
        const current = lstatSync(destination)
        if (current.dev === owned.dev && current.ino === owned.ino) {
          chmodSync(destination, 0o700)
          for (const entry of entries) if (!entry.bytes && exists(join(destination, entry.path))) chmodSync(join(destination, entry.path), 0o700)
          rmSync(destination, { recursive: true, force: true })
        }
      }
      throw error
    }
    return { name, destination, provenance }
  },
  catch: (error) => error instanceof SkillError ? error : new SkillError({ message: `Unable to import skill: ${error instanceof Error ? error.message : String(error)}` }),
})
