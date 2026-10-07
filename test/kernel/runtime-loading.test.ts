import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { effectExports } from "../../src/kernel/effect-exports"
import { makeKernel, scopeFor } from "../../src/kernel/kernel"
import { kernelImports } from "../../src/kernel/rules"

const entry = new URL(import.meta.resolve("effect")).pathname
const tsc = new URL("../../node_modules/.bin/tsc", import.meta.url).pathname
const run = (k: ReturnType<typeof makeKernel>, code: string) => Effect.runPromise(k.run(code))

test("named kernel imports include aliases and types, ignoring comments and strings", () => {
  expect(kernelImports(`// import * as Fake from "kernel"
import /* comment */ { Effect as E, type Option, pipe, } from "kernel"
import type { Schema } from 'kernel'
export const text = 'import * as fake from "kernel"'
export default E.succeed(pipe(1, n => n + 1))`)).toEqual(["Effect", "Option", "pipe", "Schema"])
  expect(kernelImports('export default 1')).toEqual([])
  expect(kernelImports('export const text = `\nimport * as fake from "kernel"\n`')).toEqual([])
})

test("namespace imports, re-exports and unfamiliar bindings retain the full scope", () => {
  for (const code of [
    'import * as K from "kernel"',
    'import type * as K from "kernel"',
    'import Default, { Effect } from "kernel"',
    'export { Effect as E } from "kernel"',
    'export * from "kernel"',
    'import { "Effect" as E } from "kernel"',
    'import { Effect as É } from "kernel"',
  ]) expect(kernelImports(code)).toBeUndefined()
})

test("the installed Effect namespaces and free functions have direct export paths", () => {
  const code = effectExports(entry, ["Effect", "Option", "pipe"]).join("\n")
  expect(code).toContain('export * as Effect from ')
  expect(code).toContain('/Effect.js"')
  expect(code).toContain('/Option.js"')
  expect(code).toContain('export { pipe } from ')
  expect(code).not.toContain('/index.js"')
  expect(effectExports(entry, ["notAnEffectExport"])).toEqual([])
  expect(effectExports(entry)).toEqual([`export * from ${JSON.stringify(entry)}`])
})

test("unrecognized package export syntax falls back to its full entry point", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-effect-entry-"))
  const entry = join(dir, "index.js")
  writeFileSync(entry, "export const futureExport = 1")
  expect(effectExports(entry, ["futureExport"])).toEqual([`export * from ${JSON.stringify(entry)}`])

  const wildcard = join(dir, "wildcard.js")
  writeFileSync(wildcard, 'export*from "./other.js"')
  expect(effectExports(wildcard, ["futureExport"])).toEqual([`export * from ${JSON.stringify(wildcard)}`])
})

test("named cells retain types, free functions, earlier definitions, and namespace access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-narrow-scope-"))
  const k = makeKernel({ dir, tsc, spareWorker: false })
  const first = await run(k, `import { Effect as E, pipe, Option } from "kernel"
import type { Effect } from "kernel"
export const saved: Effect.Effect<number> = E.succeed(7)
export default pipe(Option.some(3), Option.getOrElse(() => 0))`)
  expect(first).toMatchObject({ status: "ok", value: 3 })
  const scope = readFileSync(join(dir, "scope-1.ts"), "utf8")
  expect(scope).toContain('/Effect.js"')
  expect(scope).not.toContain('/index.js"')

  expect(await run(k, 'import { saved } from "kernel"\nexport default saved')).toMatchObject({ status: "ok", value: 7 })
  expect(await run(k, 'import * as K from "kernel"\nexport default K.Effect.succeed([K.Option.isSome(K.Option.some(1)), K.result(1)])')).toMatchObject({ status: "ok", value: [true, 3] })
  expect(readFileSync(join(dir, "scope-3.ts"), "utf8")).toContain(`export * from ${JSON.stringify(entry)}`)
  expect(await run(k, 'import { Effect } from "kernel"\nexport default Effect.succeed("x" as number)')).toMatchObject({ status: "type-error" })
  expect(await run(k, 'import { notAnEffectExport } from "kernel"\nexport default notAnEffectExport')).toMatchObject({ status: "type-error" })
}, 30_000)

test("definitions still override Effect names without loading their original modules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-shadow-scope-"))
  const k = makeKernel({ dir, tsc, spareWorker: false })
  expect(await run(k, 'export const Option = "own value"')).toMatchObject({ status: "ok" })
  expect(await run(k, 'import { Option } from "kernel"\nexport default Option')).toMatchObject({ status: "ok", value: "own value" })
  expect(readFileSync(join(dir, "scope-2.ts"), "utf8")).not.toContain('/Option.js"')

  const scope = scopeFor([], undefined, [], ["Effect"])
  expect(scope).toContain('/Effect.js"')
  expect(scope).not.toContain('/Schema.js"')
}, 30_000)

test("direct exports preserve every installed Effect export's runtime identity", async () => {
  const original = await import(entry)
  const names = Object.keys(original).filter(name => name !== "default")
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-effect-exports-"))
  const file = join(dir, "exports.ts")
  writeFileSync(file, effectExports(entry, names).join("\n"))
  const direct = await import(file)

  expect(Object.keys(direct).sort()).toEqual(names.sort())
  for (const name of names) expect(direct[name]).toBe(original[name])
})

test("regex literals and division conservatively keep the full kernel scope", () => {
  for (const code of [
    'export const pattern = /{/; import { Option } from "kernel"',
    'import { Effect } from "kernel"; export const pattern = /{/; import { Option } from "kernel"',
    'export const pattern = /{/; import * as K from "kernel"',
    'export const pattern = /{/; export { Option } from "kernel"',
    'import { Effect } from "kernel"; export default Effect.succeed(4 / 2)',
  ]) expect(kernelImports(code)).toBeUndefined()
})

test.each([false, true])("imports following regex braces still work (type checking=%s)", async typed => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-regex-import-"))
  const k = makeKernel({ dir, ...(typed ? { tsc } : {}), spareWorker: false })
  expect(await run(k, `export const pattern = /{/;
import { Option } from "kernel"
export default Option.isSome(Option.some(1))`)).toMatchObject({ status: "ok", value: true })
  expect(await run(k, `import { Effect } from "kernel"
export const another = /{/;
import { Option } from "kernel"
export default Effect.succeed(Option.isSome(Option.some(2)))`)).toMatchObject({ status: "ok", value: true })
  expect(await run(k, `export const third = /{/;
import * as K from "kernel"
export default K.Option.isSome(K.Option.some(3))`)).toMatchObject({ status: "ok", value: true })
}, 30_000)
