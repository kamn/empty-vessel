import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

// The installed Effect entry point describes its own namespace/direct exports. Re-export only
// requested names from their defining modules, without evaluating the entire package in a Worker.
// If a future package uses syntax we don't understand, retain the original full export instead.
const cache = new Map<string, ReadonlyMap<string, string> | undefined>()
const exportsFor = (entry: string) => {
  if (cache.has(entry)) return cache.get(entry)
  const source = readFileSync(entry, "utf8")
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
  const exports = new Map<string, string>()
  const path = (specifier: string) => JSON.stringify(resolve(dirname(entry), specifier))

  for (const match of code.matchAll(/\bexport\s+\*\s+as\s+([\w$]+)\s+from\s*["'](\.[^"']+)["']/g)) {
    exports.set(match[1]!, `export * as ${match[1]} from ${path(match[2]!)}`)
  }

  for (const match of code.matchAll(/\bexport\s*\{([^}]+)\}\s*from\s*["'](\.[^"']+)["']/g)) {
    for (const binding of match[1]!.split(",")) {
      const named = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(binding)
      if (named) exports.set(named[2] ?? named[1]!, `export { ${binding.trim()} } from ${path(match[2]!)}`)
    }
  }

  const known = new Bun.Transpiler({ loader: "js" }).scan(source).exports
  const complete = !/\bexport\s*\*\s*from\b/.test(code) && known.every(name => exports.has(name)) ? exports : undefined
  cache.set(entry, complete)
  return complete
}

export const effectExports = (entry: string, names?: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (names === undefined) return [`export * from ${JSON.stringify(entry)}`]
  const exports = exportsFor(entry)
  if (!exports) return [`export * from ${JSON.stringify(entry)}`]

  // Unknown names remain missing, as they were in the original barrel; the type checker reports them.
  return names.flatMap(name => name !== "default" && exports.has(name) ? [exports.get(name)!] : [])
}
