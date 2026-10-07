import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import fc from "fast-check"
import { makeKernel, type KernelOptions } from "../../src/kernel/kernel"

// Integration properties use real Workers, but only a fake, append-only host log.
// Replay: FC_SEED=<seed> FC_PATH=<path> bun test test/kernel/properties.test.ts -t '<test name>'
// Increase coverage: FC_RUNS=100 bun test test/kernel/properties.test.ts
const parameters = (numRuns: number) => ({
  numRuns: Number(process.env.FC_RUNS ?? numRuns),
  ...(process.env.FC_SEED === undefined ? {} : { seed: Number(process.env.FC_SEED) }),
  ...(process.env.FC_PATH === undefined ? {} : { path: process.env.FC_PATH }),
})
const tsc = new URL("../../node_modules/.bin/tsc", import.meta.url).pathname
const withKernel = async (
  check: (k: ReturnType<typeof makeKernel>, calls: unknown[]) => Promise<void>,
  options: Partial<KernelOptions> = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-properties-"))
  try {
    // No parked Worker or cached checker process to retain this temporary directory.
    const k = makeKernel({ ...options, dir, spareWorker: false, languageServer: false, timeoutMs: 5000 })
    await check(k, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const run = (k: ReturnType<typeof makeKernel>, code: string, calls: unknown[]) =>
  Effect.runPromise(k.run(code, {
    record: (value) => Effect.sync(() => { calls.push(value); return value }),
  }))
const payload = fc.string({ maxLength: 40 })
const suffix = fc.nat({ max: 100_000 })

for (const kind of ["rules", "types"] as const) {
  test(`kernel property: ${kind} rejection publishes nothing and makes no host calls`, async () => {
    await fc.assert(fc.asyncProperty(payload, suffix, fc.boolean(), fc.nat({ max: 2 }), async (value, id, before, variant) => {
      await withKernel(async (k, calls) => {
        const name = `rejected_${id}`
        const problem = kind === "types"
          ? `const invalid: number = ${JSON.stringify(value)}`
          : ["let invalid = 0", "const invalid = process.env", "const invalid = Math.random()"][variant]!
        const action = `export default call("record", ${JSON.stringify(value)})`
        const rejected = await run(k, [
          'import { call } from "kernel"',
          `export const ${name} = ${JSON.stringify(value)}`,
          ...(before ? [problem, action] : [action, problem]),
        ].join("\n"), calls)
        expect(rejected.status).toBe(kind === "types" ? "type-error" : "refused")
        expect(rejected.defines).toEqual([])
        expect(calls).toEqual([])
        expect(k.cells().flatMap(cell => cell.defines)).not.toContain(name)

        // Check actual visibility too, not just the index's metadata.
        const probe = await run(k, `import { ${name} } from "kernel"\nexport default ${name}`, calls)
        expect(probe.status).not.toBe("ok")
        expect(calls).toEqual([])

        // A rejection must not poison subsequent valid execution; also proves the host spy works.
        expect(await run(k, `import { call } from "kernel"\nexport default call("record", ${JSON.stringify(value)})`, calls))
          .toMatchObject({ status: "ok", value })
        expect(calls).toEqual([value])
      }, kind === "types" ? { tsc } : {})
    }), parameters(kind === "types" ? 10 : 20))
  }, 120_000)
}

test("kernel property: importing definition chains never repeats default actions", async () => {
  await fc.assert(fc.asyncProperty(fc.array(payload, { minLength: 1, maxLength: 5 }), async values => {
    await withKernel(async (k, calls) => {
      const expected: unknown[] = []
      for (const [i, value] of values.entries()) {
        const prior = i === 0 ? "" : `, chain_${i - 1}`
        const definition = i === 0 ? `[${JSON.stringify(value)}]` : `[...chain_${i - 1}, ${JSON.stringify(value)}]`
        const cell = await run(k, `import { call${prior} } from "kernel"
export const chain_${i} = ${definition}
export default call("record", chain_${i})`, calls)
        expected.push(values.slice(0, i + 1))
        expect(cell).toMatchObject({ status: "ok", value: values.slice(0, i + 1) })
        expect(calls).toEqual(expected)
      }
      // Read-only imports must not repeat any of the earlier actions.
      for (let i = values.length - 1; i >= 0; i--) {
        const read = await run(k, `import { chain_${i} } from "kernel"\nexport default chain_${i}`, calls)
        expect(read).toMatchObject({ status: "ok", value: values.slice(0, i + 1) })
        expect(calls).toEqual(expected)
      }
    })
  }), parameters(20))
}, 120_000)
