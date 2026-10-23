import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { makeKernel } from "../../src/kernel/kernel"

const fresh = (dir = mkdtempSync(`${tmpdir()}/empty-vessel-cells-`)) => makeKernel({ dir, timeoutMs: 5000, spareWorker: false })
const index = (k: ReturnType<typeof makeKernel>) => k.cells().map((c) => ({ n: c.n, status: c.status }))

// A cell's number is taken when it starts: a cell that never finished (stopped, or the process died while it ran)
// stays in the index as failed, and the next cell doesn't write over its files.
test("a cell stopped mid-run keeps its index entry, marked failed; the next cell gets a new number", async () => {
  const dir = mkdtempSync(`${tmpdir()}/empty-vessel-cells-`)
  const k = fresh(dir)

  const stopped = await Effect.runPromise(k.run(`export default () => new Promise(() => {})`).pipe(Effect.timeoutOption("300 millis")))
  expect(stopped._tag).toBe("None")
  expect(index(k)).toEqual([{ n: 1, status: "error" }])

  const next = await Effect.runPromise(k.run(`export default () => 2`))
  expect(next.n).toBe(2)
  expect(index(k)).toEqual([{ n: 1, status: "error" }, { n: 2, status: "ok" }])
  expect(readFileSync(`${dir}/cell-1.ts`, "utf8")).toContain("new Promise")
})

test("a cell that throws is in the index as failed; the next cell gets the next number", async () => {
  const k = fresh()

  expect((await Effect.runPromise(k.run(`export default () => { throw new Error("nope") }`))).status).toBe("error")
  expect((await Effect.runPromise(k.run(`export default () => 2`))).n).toBe(2)
  expect(index(k)).toEqual([{ n: 1, status: "error" }, { n: 2, status: "ok" }])
})
