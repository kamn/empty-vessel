import { Effect } from "effect"
import { Kernel } from "../tools/kernel-service"

// What the project says it runs on, read by code at the start of a session (no model): the version files, package
// manager and test/build commands, for System Two's briefing ("Node 24 (.nvmrc); pnpm (pnpm-lock.yaml); tests: pnpm
// test"). Through the kernel, so it's the kernel's world. When the project wants a version the PATH doesn't have, it
// says so plainly: a real run lost minutes running a repo's release tests on the wrong Node.
// ponytail: the project's root only; a monorepo's packages can say otherwise.

const LOCKS: ReadonlyArray<[string, string]> = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"], ["uv.lock", "uv"], ["poetry.lock", "poetry"]]

// The major version a spec asks for ("24", "v24.14.1", ">=20", "^18.2", "lts/*" → none), and whether `have` meets it.
const major = (spec: string) => spec.match(/\d+/)?.[0]
const meets = (spec: string, have: string) => (spec.trim().startsWith(">") ? Number(have) >= Number(major(spec)) : have === major(spec))

export const environment = (root: string) =>
  Effect.gen(function* () {
    const { files, exec } = yield* Kernel
    const read = (path: string) => files.read(root, path).pipe(Effect.map((t) => t?.trim() || undefined))
    const json = (path: string) => read(path).pipe(Effect.map((t) => { try { return t ? JSON.parse(t) as Record<string, any> : undefined } catch { return undefined } }))
    const toolVersions = (yield* read(".tool-versions"))?.split("\n").map((l) => l.trim().split(/\s+/)) ?? []
    const tool = (...names: string[]) => toolVersions.find(([n]) => names.includes(n!))?.[1]
    const pkg = yield* json("package.json")
    const lines: Array<string> = []

    // A runtime the project pins, where it says so, and what this machine's PATH has instead.
    const runtime = (name: string, wanted: ReadonlyArray<[string | undefined, string]>, versionCommand: string) =>
      Effect.gen(function* () {
        const found = wanted.find(([v]) => v)
        if (!found) return
        const [spec, from] = found as [string, string]
        const out = yield* exec(versionCommand, 5000)
        const have = /^exit 0\n/.test(out) ? out.match(/(\d+)\.\d+/)?.[1] : undefined
        const differs = have && major(spec) && !meets(spec, have)
        lines.push(`${name} ${spec} (${from})${differs ? `: this repo wants ${name} ${spec}; PATH has ${name} ${out.match(/\d+\.\d+(\.\d+)?/)?.[0]}` : !have ? `: no ${name} on PATH` : ""}`)
      })
    yield* runtime("Node", [[yield* read(".nvmrc"), ".nvmrc"], [yield* read(".node-version"), ".node-version"], [tool("nodejs", "node"), ".tool-versions"], [pkg?.volta?.node, "package.json volta"], [pkg?.engines?.node, "package.json engines"]], "node --version")
    yield* runtime("Python", [[yield* read(".python-version"), ".python-version"], [tool("python"), ".tool-versions"]], "python3 --version")

    // The package manager: what package.json says, else the lockfile.
    const locks = yield* Effect.filter(LOCKS, ([file]) => read(file).pipe(Effect.map(Boolean)))
    const manager = pkg?.packageManager ? [String(pkg.packageManager).split("@")[0]!, "package.json packageManager"] : locks[0] ? [locks[0][1], locks[0][0]] : undefined
    if (manager) lines.push(`${manager[0]} (${manager[1]})`)

    // How to test and build: package.json's scripts, else what the ecosystem's files imply.
    const run = manager?.[0] && !["uv", "poetry"].includes(manager[0]) ? manager[0] : "npm"
    const scripts = ["test", "build", "lint", "typecheck"].filter((s) => pkg?.scripts?.[s]).map((s) => `${s === "test" ? "tests" : s}: ${run}${s === "test" ? "" : " run"} ${s} (${pkg!.scripts[s]})`)
    lines.push(...scripts)
    const toolchain = (yield* read("rust-toolchain.toml"))?.match(/channel\s*=\s*"([^"]+)"/)?.[1]
    if (yield* read("Cargo.toml")) lines.push(`Rust (Cargo.toml)${toolchain ? `, toolchain ${toolchain}` : ""}; tests: cargo test`)
    const go = (yield* read("go.mod"))?.match(/^go\s+(\S+)/m)?.[1]
    if (go) lines.push(`Go ${go} (go.mod); tests: go test ./...`)
    const python = (yield* read("pyproject.toml"))?.match(/requires-python\s*=\s*"([^"]+)"/)?.[1]
    if (python) lines.push(`Python ${python} (pyproject.toml requires-python)`)

    const text = lines.length ? `<environment>\nWhat this project says it runs on (read from its files at the start of the session):\n${lines.map((l) => `- ${l}`).join("\n")}\n</environment>` : ""
    if (text) yield* Effect.logDebug(`environment probe ${JSON.stringify(lines)}`)
    return text
  })
