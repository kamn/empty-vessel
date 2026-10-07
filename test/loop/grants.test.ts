import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { ALL, type Grants, grantWarnings, narrow } from "../../src/base/grants"
import { makeKernel } from "../../src/kernel/kernel"
import { BUILTINS, builtinsModule, TSC, usableWith } from "../../src/loop/library"
import { systemTwoTools, SYSTEM_TWO_TOOLS } from "../../src/system-two/dispatch"
import { KERNEL_INSTRUCTIONS, kernelInstructions } from "../../src/system-two/instructions"
import { scopeFor } from "../../src/kernel/kernel"

// A kernel granting `g`, its built-ins module written as empty-vessel writes it (src/loop/library.ts builtinsModule).
const kernel = (g: Grants) => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-grants-"))
  writeFileSync(join(dir, "builtins.ts"), builtinsModule([], g))
  return { dir, k: makeKernel({ dir: join(dir, "kernel"), builtins: join(dir, "builtins.ts"), tsc: TSC }) }
}
const run = (g: Grants, code: string) => { const { dir, k } = kernel(g); return Effect.runPromise(k.run(code.replaceAll("DIR", dir))).then((r) => ({ ...r, dir })) }

test("System Two is told only of what the kernel grants; with everything granted, the usual texts exactly", () => {
  expect(kernelInstructions(ALL)).toBe(KERNEL_INSTRUCTIONS)
  expect(systemTwoTools(ALL)).toEqual(SYSTEM_TWO_TOOLS)

  const g = { ...ALL, shell: false, agents: false }
  const told = kernelInstructions(g), description = systemTwoTools(g)[0].description
  for (const text of [told, description]) {
    expect(text).not.toContain("bash(command")
    expect(text).not.toContain("spawn(task)")
    expect(text).toContain("bash (no shell)")
  }
  expect(told).not.toContain(`import { Effect, bash, spawn, wait } from \\"kernel\\"`) // the example that uses them is gone
  expect(told).not.toContain("import { Effect, bash, spawn, wait }")
  expect(told).toContain("judge(items, evidence, questions)") // what is granted stays
})

test("a library tool that needs a built-in the kernel doesn't grant isn't offered, nor exported to cells", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-grants-lib-"))
  writeFileSync(join(dir, "scope.ts"), scopeFor([], BUILTINS))
  writeFileSync(join(dir, "runsTests.ts"), `import { bash } from "./scope.ts"\nexport const runsTests = () => bash("bun test")\n`)
  writeFileSync(join(dir, "readsName.ts"), `import { Effect, readText } from "./scope.ts"\nexport const readsName = () => readText("package.json").pipe(Effect.map((t) => JSON.parse(t).name))\n`)
  const tools = [{ name: "runsTests", file: join(dir, "runsTests.ts") }, { name: "readsName", file: join(dir, "readsName.ts") }]

  const noShell = { ...ALL, shell: false }
  expect(tools.filter(usableWith(noShell)).map((t) => t.name)).toEqual(["readsName"])
  expect(tools.filter(usableWith(ALL)).map((t) => t.name)).toEqual(["runsTests", "readsName"])
  expect(builtinsModule(tools, noShell)).not.toContain("runsTests")
  expect(builtinsModule(tools, noShell)).toContain("readsName")
})

test("a sub-agent's grants narrow from its parent's, never widen; shell with read-only files is warned about", () => {
  expect(narrow(ALL, { shell: false, files: "read-only" })).toEqual({ ...ALL, shell: false, files: "read-only" })
  expect(narrow({ ...ALL, shell: false, files: "read-only" }, { shell: true, files: "read-write" })).toEqual({ ...ALL, shell: false, files: "read-only" })
  expect(narrow(ALL, undefined)).toEqual(ALL)
  // A value that isn't a grant (a cell can pass anything) never widens: unknown files are none, shell only if it was true
  expect(narrow({ ...ALL, files: "none" }, { files: "everything" as never }).files).toBe("none")
  expect(narrow(ALL, { files: "everything" as never }).files).toBe("none")
  expect(narrow(ALL, { shell: "yes" as never }).shell).toBe(false)

  expect(grantWarnings(ALL)).toEqual([])
  expect(grantWarnings({ ...ALL, files: "read-only" })[0]).toContain("bash can still write")
  expect(grantWarnings({ ...ALL, files: "read-only", shell: false })).toEqual([])
})
