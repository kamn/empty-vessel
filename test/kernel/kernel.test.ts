import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { rewriteImports } from "../../src/kernel/kernel"
import { makeGuardedKernel as makeKernel } from "../../src/tools/kernel-service"
import { kernelRules } from "./rules"

const fresh = (extra: Record<string, unknown> = {}) => makeKernel({ dir: mkdtempSync(`${tmpdir()}/empty-vessel-kernel-`), timeoutMs: 5000, ...extra })
const run = (k: ReturnType<typeof makeKernel>, code: string, host = {}) => Effect.runPromise(k.run(code, host))

// The rules every kernel follows, for this one: cells in a Bun Worker.
kernelRules("bun worker", makeKernel)
// And with both speed-ups off (a fresh tsc per cell, each Worker started when its cell runs): the same rules hold.
kernelRules("bun worker, plain", (options) => makeKernel({ ...options, languageServer: false, spareWorker: false }))

// How this kernel protects the machine (and an internal helper): its own, not every kernel's.
test("a cell's imports from \"kernel\" point at its own scope", () => {
  expect(rewriteImports(`import { Effect } from "kernel"\nconst m = await import('kernel')`, 3)).toBe(`import { Effect } from "./scope-3.ts"\nconst m = await import("./scope-3.ts")`)
})

test("a cell can't read process; its commands see only a safe environment, never the host's secrets", async () => {
  process.env.KERNEL_TEST_SECRET = "hunter2"
  const k = makeKernel({ dir: mkdtempSync(`${tmpdir()}/empty-vessel-kernel-`), builtins: new URL("../../src/tools/kernel-builtins.ts", import.meta.url).pathname })
  expect((await run(k, `export default () => process.env.KERNEL_TEST_SECRET`)).status).toBe("refused")
  const r = await run(k, `import { bash } from "kernel"\nexport default bash("echo \\"[$KERNEL_TEST_SECRET]\\" && test -n \\"$PATH\\" && echo path")`)
  expect(r.value).toContain("[]")
  expect(r.value).toContain("path")
})

test("errors, process.exit and runaway cells are reported, and don't touch the host", async () => {
  const k = fresh({ timeoutMs: 800 })
  expect((await run(k, `export default () => { throw new Error("nope") }`)).error).toContain("nope")
  expect((await run(k, `export default () => process.exit(3)`)).status).toBe("refused")
  const stuck = await run(k, `export default () => { while (true) {} }`)
  expect(stuck.status).toBe("timeout")
})

test("raw side effects fail at run time too, when a cell gets past the source scan: Bun's processes and files, the network", async () => {
  const k = makeKernel({ dir: mkdtempSync(`${tmpdir()}/empty-vessel-kernel-`), builtins: new URL("../../src/tools/kernel-builtins.ts", import.meta.url).pathname })
  // The async-function constructor runs code the scan never sees (it's in a string).
  const sneak = (body: string) => run(k, `import { Effect, bash } from "kernel"\nconst Make = Object.getPrototypeOf(async function () {}).constructor\nexport default Effect.gen(function* () { const got = yield* Effect.tryPromise(() => Make(${JSON.stringify(body)})()).pipe(Effect.match({ onFailure: (e) => String((e as { cause?: unknown }).cause ?? e), onSuccess: () => "ran" })); return [got, yield* bash("echo still works")] })`)
  for (const body of [`return Bun.spawnSync(["echo", "hi"])`, `return Bun.file("/etc/hosts").text()`, `return fetch("http://localhost:1")`]) {
    const r = await sneak(body)
    expect(r.status).toBe("ok")
    expect(String((r.value as Array<string>)[0])).toContain("isn't available in a cell")
    expect(String((r.value as Array<string>)[1])).toContain("still works") // the kernel's own bash isn't blocked
  }
})

// The type check from the language server, or, when it can't answer, a fresh tsc per cell: the check is never skipped.
test("a tsc without a language server still checks every cell (the fallback)", async () => {
  const real = new URL("../../node_modules/.bin/tsc", import.meta.url).pathname
  const dir = mkdtempSync(`${tmpdir()}/empty-vessel-nolsp-`)
  const tsc = `${dir}/tsc`
  writeFileSync(tsc, `#!/bin/sh\ncase "$1" in --lsp) exit 1;; esac\nexec "${real}" "$@"\n`)
  require("node:fs").chmodSync(tsc, 0o755)

  const started = performance.now()
  const k = makeKernel({ dir: `${dir}/kernel`, timeoutMs: 5000, tsc })
  expect(await Effect.runPromise(k.run(`export const n: number = 1`))).toMatchObject({ status: "ok" })
  const bad = await Effect.runPromise(k.run(`import { n } from "kernel"\nexport const s: string = n`))
  expect(bad.status).toBe("type-error")
  expect(bad.summary).toContain("not assignable to type 'string'")
  // A closed server must fall back without waiting out even one 20-second initialization timeout.
  expect(performance.now() - started).toBeLessThan(10_000)
}, 15_000)
