import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { makeKernel, type Cell, type KernelOptions } from "../../src/kernel/kernel"
import { closeChecker } from "../../src/kernel/checker"

// Integration properties use real Workers, but only a fake, append-only host log.
// A failure found once is replayed first on the next run (.hegel/, gitignored). Replay one elsewhere:
// HEGEL_SEED=<seed> bun test test/kernel/properties.test.ts -t '<test name>'
// Increase coverage: HEGEL_CASES=100 bun test test/kernel/properties.test.ts
const settings = (testCases: number): hegel.Settings => ({
  testCases: Number(process.env.HEGEL_CASES ?? testCases),
  ...(process.env.HEGEL_SEED === undefined ? {} : { seed: BigInt(process.env.HEGEL_SEED) }),
})
const tsc = new URL("../../node_modules/.bin/tsc", import.meta.url).pathname
const suiteDir = mkdtempSync(join(tmpdir(), "empty-vessel-properties-"))
afterAll(async () => {
  await closeChecker(tsc)
  rmSync(suiteDir, { recursive: true, force: true })
})

const withKernel = async (
  check: (k: ReturnType<typeof makeKernel>, calls: unknown[], reopen: () => ReturnType<typeof makeKernel>) => Promise<void>,
  options: Partial<KernelOptions> = {},
) => {
  const dir = mkdtempSync(join(suiteDir, "case-"))
  // Share the checker, not session state. Keep its working directory until afterAll stops it.
  // Fresh Workers still run every cell; plain-compiler coverage lives in kernel.test.ts.
  const reopen = () => makeKernel({ ...options, dir, spareWorker: false, timeoutMs: 5000 })
  await check(reopen(), [], reopen)
}
const run = (k: ReturnType<typeof makeKernel>, code: string, calls: unknown[]) =>
  Effect.runPromise(k.run(code, {
    record: (value) => Effect.sync(() => { calls.push(value); return value }),
  }))
const payload = gs.text({ maxSize: 40 })

for (const kind of ["rules", "types"] as const) {
  test(`kernel property: ${kind} rejection publishes nothing and makes no host calls`, async () => {
    await hegel.testAsync(async tc => {
      const value = tc.draw(payload, "value"), id = tc.draw(gs.integers({ minValue: 0, maxValue: 100_000 }), "id")
      const before = tc.draw(gs.booleans(), "before"), variant = tc.draw(gs.integers({ minValue: 0, maxValue: 2 }), "variant")
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
    }, settings(kind === "types" ? 10 : 20))
  }, 120_000)
}

test("kernel property: importing definition chains never repeats default actions", async () => {
  await hegel.testAsync(async tc => {
    const values = tc.draw(gs.arrays(payload, { minSize: 1, maxSize: 5 }), "values")
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
  }, settings(20))
}, 120_000)

// Each generated sequence includes every failure kind, in a shuffled order, and
// reopens after each failure. Extra reopens occur at generated boundaries. The
// model contains only expected journal entries, immutable values, and host calls;
// it never derives its expectations from the kernel's persisted state.
test("kernel property: failures and reopening preserve session state without replay", async () => {
  const rounds = gs.arrays(gs.record({ value: payload, reopenBefore: gs.booleans() }), { minSize: 3, maxSize: 3 })
  await hegel.testAsync(async tc => {
    const initial = tc.draw(payload, "initial"), kinds = tc.draw(gs.permutations(["rules", "types", "runtime"] as const), "kinds")
    const steps = tc.draw(rounds, "steps")
    await withKernel(async (first, calls, reopen) => {
      let k = first
      let nextId = 1
      const journal: Array<{ n: number; status: Cell["status"]; defines: string[] }> = []
      const saved: Array<{ name: string; n: number; value: string }> = []
      const expectedCalls: unknown[] = []
      const assertJournal = () => {
        expect(k.cells().map(({ n, status, defines }) => ({ n, status, defines }))).toEqual(journal)
        expect(calls).toEqual(expectedCalls)
      }
      const execute = async (code: string, status: "ok" | "refused" | "type-error" | "error", defines: string[] = []) => {
        const n = nextId++
        const actual = await run(k, code, calls)
        expect(actual).toMatchObject({ n, status, defines })
        journal.push({ n, status, defines })
        assertJournal()
        return actual
      }
      const save = async (value: string) => {
        const name = `saved_${saved.length}`
        const n = nextId
        expectedCalls.push(value)
        const actual = await execute(`import { call } from "kernel"
export const ${name} = ${JSON.stringify(value)}
export default call("record", ${name})`, "ok", [name])
        expect(actual.value).toEqual(value)
        saved.push({ name, n, value })
      }
      const checkSaved = async () => {
        const actual = await execute(`import { result, ${saved.map(s => s.name).join(", ")} } from "kernel"
export default () => [${saved.map(s => `[${s.name}, result(${s.n})]`).join(", ")}]`, "ok")
        expect(actual.value).toEqual(saved.map(s => [s.value, s.value]))
      }
      const openAgain = () => {
        k = reopen()
        assertJournal()
      }

      await save(initial)
      for (const [i, kind] of kinds.entries()) {
        const step = steps[i]!
        if (step.reopenBefore) {
          openAgain()
          await checkSaved()
        }
        const failedName = `failed_${i}`
        // Failed cells try both a new name and shadowing an existing definition.
        const definitions = `export const ${failedName} = ${JSON.stringify(step.value)}\nexport const saved_0 = "poison"`
        const marker = { failed: i, value: step.value }
        const body = kind === "rules"
          ? `let forbidden = 0\nexport default call("record", ${JSON.stringify(marker)})`
          : kind === "types"
            ? `const invalid: number = ${JSON.stringify(step.value)}\nexport default call("record", ${JSON.stringify(marker)})`
            : `export default Effect.gen(function* () { yield* call("record", ${JSON.stringify(marker)}); return yield* Effect.fail(new Error("generated failure")) })`
        // Runtime failure does NOT roll back host effects that already happened.
        if (kind === "runtime") expectedCalls.push(marker)
        await execute(`import { Effect, call } from "kernel"\n${definitions}\n${body}`,
          kind === "rules" ? "refused" : kind === "types" ? "type-error" : "error")
        await checkSaved()
        const probe = `import { ${failedName} } from "kernel"\nexport default ${failedName}`
        await execute(probe, "type-error")

        openAgain()
        await checkSaved()
        await execute(probe, "type-error") // failed names stay hidden after reopening
        await save(step.value) // new work and IDs continue after failed cells and reopen
        await checkSaved()
      }
      openAgain()
      await checkSaved()
    }, { tsc })
  }, settings(10))
}, 180_000)
