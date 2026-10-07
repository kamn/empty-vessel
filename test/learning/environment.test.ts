import { expect, test } from "bun:test"
import { Effect } from "effect"
import { environment } from "../../src/learning/environment"
import { Kernel, type KernelService } from "../../src/tools/kernel-service"

// A kernel whose world is a made-up project, and whose PATH has the given versions.
const world = (files: Record<string, string>, path: Record<string, string> = {}) => {
  const fake: KernelService = {
    open: () => { throw new Error("no cells here") },
    exec: (command) => Effect.succeed(path[command] ? `exit 0\n${path[command]}` : "exit 127\ncommand not found"),
    files: { list: () => Effect.succeed(Object.keys(files)), grep: () => Effect.succeed([]), read: (_, p) => Effect.succeed(files[p]), size: (_, p) => Effect.succeed(files[p]?.length ?? 0) },
  }
  return Effect.runPromise(environment("/repo").pipe(Effect.provideService(Kernel, fake)))
}

test("the probe: the pinned Node, said plainly when PATH has another; the package manager; the scripts", async () => {
  const text = await world({ ".nvmrc": "24\n", "pnpm-lock.yaml": "x", "package.json": JSON.stringify({ scripts: { test: "vitest run", build: "tsc" } }) }, { "node --version": "v20.11.1" })
  expect(text).toContain("- Node 24 (.nvmrc): this repo wants Node 24; PATH has Node 20.11.1")
  expect(text).toContain("- pnpm (pnpm-lock.yaml)")
  expect(text).toContain("- tests: pnpm test (vitest run)")
  expect(text).toContain("- build: pnpm run build (tsc)")
})

test("the probe: a version PATH meets says nothing more; packageManager wins over lockfiles; other ecosystems; nothing found, nothing said", async () => {
  expect(await world({ "package.json": JSON.stringify({ engines: { node: ">=20" }, packageManager: "yarn@4.1.0" }), "package-lock.json": "x" }, { "node --version": "v22.3.0" }))
    .toBe("<environment>\nWhat this project says it runs on (read from its files at the start of the session):\n- Node >=20 (package.json engines)\n- yarn (package.json packageManager)\n</environment>")
  expect(await world({ "go.mod": "module x\n\ngo 1.22\n", "Cargo.toml": "[package]", "rust-toolchain.toml": 'channel = "1.80"' })).toContain("- Go 1.22 (go.mod); tests: go test ./...")
  expect(await world({ ".python-version": "3.12" })).toContain("- Python 3.12 (.python-version): no Python on PATH")
  expect(await world({ "README.md": "# x" })).toBe("")
})
