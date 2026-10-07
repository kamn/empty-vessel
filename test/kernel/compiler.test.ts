import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { makeKernel } from "../../src/kernel/kernel"

const action = `import { call } from "kernel"\nexport default call("count")`
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
const compiler = (dir: string, body: string) => {
  const path = `${dir}/tsc`
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

test.each([false, true])("a silent compiler failure never runs a cell (languageServer=%s)", async (languageServer) => {
  const dir = mkdtempSync(`${tmpdir()}/empty-vessel-silent-tsc-`)
  const tsc = compiler(dir, "exit 7")
  let calls = 0
  const k = makeKernel({ dir: `${dir}/kernel`, tsc, languageServer, spareWorker: false })
  const r = await Effect.runPromise(k.run(action, { count: () => Effect.sync(() => ++calls) }))

  expect(calls).toBe(0)
  expect(r.status).toBe("type-error")
  expect(r.error).toContain("7")
  expect(r.defines).toEqual([])
  expect(existsSync(`${dir}/kernel/results/1.json`)).toBe(false)
}, 15_000)

const reports = [null, {}, { kind: "full" }, { kind: "full", items: null }, { kind: "unchanged", resultId: "unknown" }]
for (const report of reports) {
  test(`an invalid LSP report falls back, never authorizes execution: ${JSON.stringify(report)}`, async () => {
    const dir = mkdtempSync(`${tmpdir()}/empty-vessel-invalid-lsp-`)
    const fallback = `${dir}/fallback`
    const fixture = new URL("./fixtures/fake-tsc.ts", import.meta.url).pathname
    const tsc = compiler(dir, `exec ${quote(process.execPath)} ${quote(fixture)} ${quote(JSON.stringify(report))} ${quote(fallback)} "$@"`)
    let calls = 0
    const k = makeKernel({ dir: `${dir}/kernel`, tsc, spareWorker: false })
    const r = await Effect.runPromise(k.run(action, { count: () => Effect.sync(() => ++calls) }))

    expect(calls).toBe(0)
    expect(r.status).toBe("type-error")
    expect(r.error).toContain("7")
    expect(readFileSync(fallback, "utf8")).toBe("fallback\n")
    expect(existsSync(`${dir}/kernel/results/1.json`)).toBe(false)
  }, 15_000)
}

test("a valid empty LSP report permits execution without fallback", async () => {
  const dir = mkdtempSync(`${tmpdir()}/empty-vessel-valid-lsp-`)
  const fallback = `${dir}/fallback`
  const fixture = new URL("./fixtures/fake-tsc.ts", import.meta.url).pathname
  const tsc = compiler(dir, `exec ${quote(process.execPath)} ${quote(fixture)} ${quote(JSON.stringify({ kind: "full", items: [] }))} ${quote(fallback)} "$@"`)
  let calls = 0
  const k = makeKernel({ dir: `${dir}/kernel`, tsc, spareWorker: false })
  const r = await Effect.runPromise(k.run(action, { count: () => Effect.sync(() => ++calls) }))

  expect(r).toMatchObject({ status: "ok", value: 1 })
  expect(calls).toBe(1)
  expect(existsSync(fallback)).toBe(false)
}, 15_000)
