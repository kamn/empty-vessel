// The core's API as plugins see it, as text: every export of
// src/core.ts with its declaration as tsc emits it, and the config file's schema, one setting per line. Written to
// core-api.txt and committed, so every change to what the core promises shows in a diff; test/core-api.test.ts fails
// when the file is stale.
// Usage: bun scripts/core-api.ts           → print the API, and what changed against core-api.txt
//        bun scripts/core-api.ts --write   → write core-api.txt (refused unless CORE_VERSION, src/base/version.ts, is bumped enough)
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { ConfigSchema } from "../src/base/config"
import { CORE_VERSION } from "../src/core"

const ROOT = join(import.meta.dir, "..")
export const API_FILE = join(ROOT, "core-api.txt")

// Declarations for src/core.ts and what it imports, from tsc (TypeScript 7 has no JavaScript API to ask instead).
const declarations = () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-core-api-"))
  const config = { extends: join(ROOT, "tsconfig.json"), files: [join(ROOT, "src/core.ts")], include: [],
    compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: join(dir, "out"), rootDir: join(ROOT, "src"), typeRoots: [join(ROOT, "node_modules/@types")] } }
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(config))
  Bun.spawnSync([join(ROOT, "node_modules/.bin/tsc"), "-p", join(dir, "tsconfig.json")], { cwd: ROOT })
  return { out: join(dir, "out"), done: () => rmSync(dir, { recursive: true, force: true }) }
}

// One declaration statement for `name` in a .d.ts: from its line to where the brackets close and the statement ends.
// A class from Context.Service or Data.TaggedError comes with the `NAME_base` const tsc declares for it.
const statement = (text: string, name: string) => {
  const lines = text.split("\n")
  const starts = lines.flatMap((l, i) => (new RegExp(`^(export )?(declare )?(const|class|type|interface|function) ${name}(_base)?\\b`).test(l) ? [i] : []))
  return starts.map((start) => {
    let depth = 0, end = start
    for (; end < lines.length; end++) {
      for (const c of lines[end]!) depth += "{[(".includes(c) ? 1 : ")]}".includes(c) ? -1 : 0
      if (depth <= 0 && /[;}]\s*$/.test(lines[end]!)) break
    }
    return lines.slice(start, end + 1).join("\n")
  }).join("\n").replace(/import\("[^"]+"\)\./g, "")
}

// Every export of core.ts, by name: its declaration, and the types it names that the core doesn't export (a plugin
// can't name them, so they're promises the API makes without saying so).
export const exportsOf = () => {
  const { out, done } = declarations()
  const core = readFileSync(join(out, "core.d.ts"), "utf8")
  const entries = [...core.matchAll(/export (?:type )?\{([^}]*)\} from "([^"]+)"/g)].flatMap((m) =>
    m[1]!.split(",").map((n) => n.trim().replace(/^type /, "")).filter(Boolean).map((name) => ({ name, from: m[2]! })))

  // Declared in core.ts itself (not CORE_VERSION: that's the version, not the API).
  const own = [...core.matchAll(/^export (?:declare )?(?:const|class|type|interface|function) (\w+)/gm)].map((m) => m[1]!).filter((n) => n !== "CORE_VERSION")
  entries.push(...own.map((name) => ({ name, from: "./core" })))
  entries.splice(0, entries.length, ...entries.filter((e) => e.name !== "CORE_VERSION")) // the version, not the API
  const exported = new Set(entries.map((e) => e.name))
  const api = entries.map(({ name, from }) => {
    const file = join(out, `${from}.d.ts`)
    const text = existsSync(file) ? readFileSync(file, "utf8") : ""
    const declaration = statement(text, name)
    const imported = [...text.matchAll(/import (?:type )?\{([^}]*)\} from "(\.[^"]+)"/g)].flatMap((m) => m[1]!.split(",").map((n) => n.trim().replace(/^type /, "")))
    const unexported = imported.filter((n) => !exported.has(n) && new RegExp(`\\b${n}\\b`).test(declaration))
    return { name, from: from.replace(/^\.\//, "src/"), declaration, unexported }
  }).sort((a, b) => a.name.localeCompare(b.name))
  done()
  return api
}

// The config file's schema, one line per setting (records as *), so a setting removed or narrowed shows as a change.
export const configLines = () => {
  const lines: Array<string> = []
  const walk = (node: any, path: string) => {
    if (node?.type === "object" && node.properties) for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.${k}`)
    else if (node?.type === "object" && typeof node.additionalProperties === "object") walk(node.additionalProperties, `${path}.*`)
    else lines.push(`${path}: ${JSON.stringify(node)}`)
  }
  walk(Schema.toJsonSchemaDocument(ConfigSchema).schema, "config")
  return lines
}

// The API as text: a header with the version, each export as a block, then the config.
export const render = (version = CORE_VERSION) => {
  const api = exportsOf()
  return [`# empty-vessel core ${version}`, "# Written by scripts/core-api.ts; checked by test/core-api.test.ts. Edit src/core.ts, not this.", "",
    ...api.flatMap((e) => [`## ${e.name} (${e.from})`, e.declaration, ...(e.unexported.length ? [`// names types the core doesn't export: ${e.unexported.join(", ")}`] : []), ""]),
    "## config", ...configLines(), ""].join("\n")
}

// What changed between two renders: entries (an export's block, or a config line) added, removed or changed.
const entriesOf = (text: string) => {
  const map = new Map<string, string>()
  for (const block of text.split(/\n(?=## )/).slice(1)) {
    const [head, ...body] = block.split("\n")
    if (head === "## config") for (const l of body.filter(Boolean)) map.set(l.split(":")[0]!, l)
    else map.set(head!.replace(/^## /, "").split(" ")[0]!, body.filter((l) => !l.startsWith("// names types")).join("\n").trim())
  }
  return map
}
export const changes = (before: string, after: string) => {
  const [a, b] = [entriesOf(before), entriesOf(after)]
  return {
    added: [...b.keys()].filter((k) => !a.has(k)),
    removed: [...a.keys()].filter((k) => !b.has(k)),
    changed: [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)),
  }
}

// The version a change needs (semver): at 0.0.x (experimental: anything may break) every change bumps the patch;
// below 1.0 a breaking change bumps the minor, anything else the patch.
export const versionOf = (text: string) => text.match(/^# empty-vessel core (\S+)/)?.[1] ?? "0.0.0"
export const needed = (from: string, c: ReturnType<typeof changes>) => {
  const [major, minor, patch] = from.split(".").map(Number) as [number, number, number]
  const breaking = c.removed.length + c.changed.length > 0, added = c.added.length > 0
  if (!breaking && !added) return from
  if (major === 0 && minor === 0) return `0.0.${patch + 1}`
  if (major === 0) return breaking ? `0.${minor + 1}.0` : `0.${minor}.${patch + 1}`
  return breaking ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`
}
const atLeast = (v: string, min: string) => { const [a, b] = [v, min].map((x) => x.split(".").map(Number)); for (let i = 0; i < 3; i++) if (a![i] !== b![i]) return a![i]! > b![i]!; return true }

if (import.meta.main) {
  const before = existsSync(API_FILE) ? readFileSync(API_FILE, "utf8") : ""
  const after = render()
  const c = changes(before, after), need = before ? needed(versionOf(before), c) : CORE_VERSION
  const summary = `added ${c.added.join(", ") || "nothing"} · removed ${c.removed.join(", ") || "nothing"} · changed ${c.changed.join(", ") || "nothing"}`

  if (!process.argv.includes("--write")) console.log(`${after}\n${summary}\nneeds at least ${need} (CORE_VERSION is ${CORE_VERSION})`)
  else if (before && !atLeast(CORE_VERSION, need)) { console.error(`${summary}\nthat needs CORE_VERSION ${need} or more (src/base/version.ts says ${CORE_VERSION})`); process.exit(1) }
  else { writeFileSync(API_FILE, after); console.log(`wrote core-api.txt (${CORE_VERSION}): ${summary}`) }
}
