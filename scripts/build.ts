// Build empty-vessel as one executable: `bun run build` → dist/empty-vessel (for this machine's platform).
// 1. The kit (build/kit): what the kernel needs on disk at run time, in the layout it expects: its own source files
//    (the Worker, the runtime, the guard, empty-vessel's built-ins and what they import), Effect, Bun's types and the
//    TypeScript compiler for the type check. Packed as build/kit.tar.gz.
// 2. The executable: scripts/entry.ts compiled with the kit embedded; it unpacks the kit on first run.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const KIT = join(ROOT, "build", "kit")
const copy = (from: string, to = from, filter?: (path: string) => boolean) =>
  cpSync(join(ROOT, from), join(KIT, to), { recursive: true, ...(filter ? { filter } : {}) })

// The kernel's source files (worker.ts and kernel-builtins.ts, and everything they import from empty-vessel).
const SOURCES = [
  "src/kernel/worker.ts", "src/kernel/runtime.ts", "src/kernel/guard.ts",
  "src/tools/kernel-builtins.ts", "src/tools/tools.ts", "src/tools/bash.ts", "src/tools/judge-rules.ts",
  "src/base/json-schema.ts", "src/base/grants.ts",
]
// A file of the list that imports empty-vessel code outside it would fail in the kit: say so rather than ship it.
const missing = SOURCES.flatMap((file) =>
  new Bun.Transpiler({ loader: "ts" }).scan(readFileSync(join(ROOT, file), "utf8")).imports
    .filter((i) => i.path.startsWith("."))
    .map((i) => join(dirname(file), i.path).replace(/(\.ts)?$/, ".ts"))
    .filter((dep) => !SOURCES.includes(dep)))
if (missing.length) throw new Error(`the kit's sources import files not in the kit: ${[...new Set(missing)].join(", ")}`)

const platform = `typescript-${process.platform}-${process.arch}`

rmSync(join(ROOT, "build"), { recursive: true, force: true })
mkdirSync(KIT, { recursive: true })
for (const file of SOURCES) copy(file)
copy("node_modules/effect/package.json")
copy("node_modules/effect/dist", "node_modules/effect/dist", (path) => !path.endsWith(".map"))
for (const types of ["@types/bun", "@types/node", "bun-types"]) copy(`node_modules/${types}`)
copy(`node_modules/@typescript/${platform}/lib`, "tsc/lib")

const size = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0)
console.log(`kit: ${(size(KIT) / 1e6).toFixed(1)} MB`)

const tar = Bun.spawnSync(["tar", "-czf", "../kit.tar.gz", "."], { cwd: KIT, stderr: "pipe" })
if (tar.exitCode !== 0) throw new Error(`tar: ${tar.stderr.toString()}`)
console.log(`kit.tar.gz: ${(statSync(join(ROOT, "build", "kit.tar.gz")).size / 1e6).toFixed(1)} MB`)

const built = Bun.spawnSync(["bun", "build", "--compile", "scripts/entry.ts", "--outfile", "dist/empty-vessel"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" })
if (built.exitCode !== 0) process.exit(built.exitCode ?? 1)
console.log(`dist/empty-vessel: ${(statSync(join(ROOT, "dist", "empty-vessel")).size / 1e6).toFixed(1)} MB`)
