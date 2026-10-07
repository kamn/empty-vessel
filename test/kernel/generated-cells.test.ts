import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeKernel } from "../../src/kernel/kernel"

for (const spareWorker of [true, false]) {
  test(`fresh Workers see newly generated cells and scopes (spareWorker=${spareWorker})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "empty-vessel-generated-cells-"))
    const k = makeKernel({ dir, spareWorker })
    const run = (code: string) => Effect.runPromise(k.run(code))

    try {
      // No checker or delays: each new file must be importable immediately, even after a Worker
      // has already resolved another module in this directory. Every run still gets a fresh Worker.
      expect(await run('export const value = 0\nexport default value')).toMatchObject({ status: "ok", value: 0 })

      for (let n = 1; n <= 6; n++) {
        expect(await run('import { value as previous } from "kernel"\nexport const value = previous + 1\nexport default value'))
          .toMatchObject({ status: "ok", value: n })
      }

      expect(await Effect.runPromise(k.text("label", "saved text"))).toMatchObject({ status: "ok" })
      expect(await run('import { label, value } from "kernel"\nexport default [label, value]'))
        .toMatchObject({ status: "ok", value: ["saved text", 6] })

      const reopened = makeKernel({ dir, spareWorker })
      expect(await Effect.runPromise(reopened.run('import { label, value } from "kernel"\nexport default [label, value]')))
        .toMatchObject({ status: "ok", value: ["saved text", 6] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("generated-module resolution preserves external built-ins and missing-file errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "empty-vessel-resolve-boundary-"))
  const dir = join(root, "kernel")
  // Same basename pattern, outside the kernel directory: leave this on Bun's normal resolver.
  const builtins = join(root, "cell-99.ts")
  writeFileSync(builtins, "export const external = 9")
  const k = makeKernel({ dir, builtins })
  const run = (code: string) => Effect.runPromise(k.run(code))

  try {
    expect(await run('import { external } from "kernel"\nexport const saved = external\nexport default saved'))
      .toMatchObject({ status: "ok", value: 9 })
    expect(await run('import { saved } from "kernel"\nexport default saved + 1'))
      .toMatchObject({ status: "ok", value: 10 })

    rmSync(join(dir, "cell-1.ts"))
    const missing = await run('import { saved } from "kernel"\nexport default saved')
    expect(missing.status).toBe("error")
    expect(missing.error).toContain("cell-1.ts")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("generated-module resolution works through a symlink and paths with spaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "empty-vessel-resolve-path-"))
  const actual = join(root, "actual kernel")
  const alias = join(root, "linked kernel")
  mkdirSync(actual)
  symlinkSync(actual, alias, "dir")
  const k = makeKernel({ dir: alias })

  try {
    expect(await Effect.runPromise(k.run('export const saved = 7\nexport default saved')))
      .toMatchObject({ status: "ok", value: 7 })
    expect(await Effect.runPromise(k.run('import { saved } from "kernel"\nexport default saved + 1')))
      .toMatchObject({ status: "ok", value: 8 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
