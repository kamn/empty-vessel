import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, normalize, relative } from "node:path"

// src/ folders may only import downward: base, ui and kernel at the bottom, then tools, then System One and System Two
// (their contracts), then the plugins that implement them, then learning, then the loop, then main.ts. It keeps each layer usable without the ones above it. The kernel is a
// library: at the bottom, it may import nothing from the rest of empty-vessel.
const LEVEL: Record<string, number> = { base: 0, ui: 0, kernel: 0, tools: 1, "system-one": 2, "system-two": 2, plugins: 3, learning: 4, loop: 5, main: 6 }
const SRC = join(import.meta.dir, "../src")
const folderOf = (file: string) => (relative(SRC, file).includes("/") ? relative(SRC, file).split("/")[0]! : "main")

test("src/ folders only import downward", () => {
  const files = readdirSync(SRC, { recursive: true }).map(String).filter((f) => f.endsWith(".ts")).map((f) => join(SRC, f))
  const wrong = files.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/from "(\.{1,2}\/[^"]+)"/g)]
      .map((m) => normalize(join(dirname(file), m[1]!)) + ".ts")
      .filter((target) => folderOf(target) !== folderOf(file) && LEVEL[folderOf(target)]! >= LEVEL[folderOf(file)]!)
      .map((target) => `${relative(SRC, file)} → ${relative(SRC, target)}`))
  expect(wrong).toEqual([])
})

// A plugin (src/plugins/<name>/) never imports another: what they share is the core's. Only the registry
// (src/plugins/index.ts) knows them all.
test("plugins don't import each other", () => {
  const PLUGINS = join(SRC, "plugins")
  const pluginOf = (file: string) => (relative(PLUGINS, file).includes("/") && !relative(PLUGINS, file).startsWith("..") ? relative(PLUGINS, file).split("/")[0]! : undefined)
  const files = readdirSync(PLUGINS, { recursive: true }).map(String).filter((f) => f.endsWith(".ts")).map((f) => join(PLUGINS, f))
  const wrong = files.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/from "(\.{1,2}\/[^"]+)"/g)]
      .map((m) => normalize(join(dirname(file), m[1]!)) + ".ts")
      .filter((target) => pluginOf(file) && pluginOf(target) && pluginOf(target) !== pluginOf(file))
      .map((target) => `${relative(SRC, file)} → ${relative(SRC, target)}`))
  expect(wrong).toEqual([])
})


// A plugin reaches the core only through its package entry, "empty-vessel" (src/core.ts: the versioned API), never by a path
// into it or another entry: what plugins can depend on is then exactly what core-api.txt records.
test("plugins import the core only by its package name", () => {
  const PLUGINS = join(SRC, "plugins")
  const files = readdirSync(PLUGINS, { recursive: true }).map(String).filter((f) => f.includes("/") && f.endsWith(".ts")).map((f) => join(PLUGINS, f))
  const wrong = files.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1]!)
      .filter((spec) => (spec.startsWith(".") && !normalize(join(dirname(file), spec)).startsWith(dirname(file))) || spec.startsWith("empty-vessel/"))
      .map((spec) => `${relative(SRC, file)} → ${spec}`))
  expect(wrong).toEqual([])
})
