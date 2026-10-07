// A cell's rules, checked on its source before it runs, like the syntax and type checks:
// the top level only defines things, and every side effect goes through the kernel's services (so it shows in the
// Effect's requirements). Each problem says what to write instead.
// ponytail: a scan of the source (strings and comments blanked), not a syntax tree; it catches
// habits, not deliberate escapes. A parser (oxc-parser) is the upgrade if it misses too much or flags too much.

const RULES: ReadonlyArray<{ readonly pattern: RegExp; readonly say: string }> = [
  { pattern: /(?<![.\w$])Bun\b/, say: "Bun isn't available in a cell: use the kernel's read, readText, write, edit and bash" },
  { pattern: /(?<![.\w$])(require|eval)\s*\(|(?<![.\w$])Function\s*\(|\bnew\s+Function\b|(?<![.\w$])import\s*\(/, say: "require, eval, Function and import() aren't allowed in a cell: import from \"kernel\"" },
  { pattern: /(?<![.\w$])(fetch|WebSocket|XMLHttpRequest|Worker)\b/, say: "the network and workers aren't available in a cell: use the kernel's services (a tool source, bash, spawn)" },
  { pattern: /(?<![.\w$])(setTimeout|setInterval|setImmediate|queueMicrotask)\b/, say: "timers aren't available in a cell: use Effect.sleep or a Schedule" },
  { pattern: /(?<![.\w$])(process|globalThis)\b/, say: "process and globalThis aren't available in a cell: the kernel's services give what's needed" },
  { pattern: /(?<![.\w$])Date\s*\.\s*now\b|\bnew\s+Date\s*\(\s*\)|(?<![.\w$])performance\s*\.\s*now\b/, say: "the time isn't read directly in a cell: use now() from \"kernel\" (new Date(\"2026-01-01\") is fine)" },
  { pattern: /(?<![.\w$])Math\s*\.\s*random\b|(?<![.\w$])crypto\s*\./, say: "randomness isn't read directly in a cell: use random() from \"kernel\"" },
  { pattern: /\bEffect\s*\.\s*run(Promise|Sync|Fork|Callback)\w*/, say: "don't run Effects by hand in a cell: yield* them inside an Effect (the kernel runs the default export)" },
]

// The source with string and template text, comments and regular expressions' insides blanked (newlines kept, so
// line numbers stay), and each character's brace depth (0: the top level).
const blank = (js: string) => {
  let out = "", depth = 0
  const depths: Array<number> = []
  const templates: Array<number> = [] // brace depth where each open template's ${ … } started
  const put = (c: string) => { out += c; depths.push(depth) }

  for (let i = 0; i < js.length; i++) {
    const c = js[i]!, next = js[i + 1]

    if (c === "/" && next === "/") { while (i < js.length && js[i] !== "\n") { put(" "); i++ } put("\n"); continue }
    if (c === "/" && next === "*") { const end = js.indexOf("*/", i + 2); const stop = end < 0 ? js.length : end + 2; for (; i < stop; i++) put(js[i] === "\n" ? "\n" : " "); i--; continue }
    if (c === "\"" || c === "'") { put(c); for (i++; i < js.length && js[i] !== c; i++) { if (js[i] === "\\") { put(" "); i++ } put(js[i] === "\n" ? "\n" : " ") } put(c); continue }
    if (c === "`" || (c === "}" && templates.at(-1) === depth)) {
      if (c === "}") templates.pop()
      put(c)
      for (i++; i < js.length && js[i] !== "`"; i++) {
        if (js[i] === "\\") { put(" "); i++; put(" "); continue }
        if (js[i] === "$" && js[i + 1] === "{") { put("$"); put("{"); i++; templates.push(depth); break }
        put(js[i] === "\n" ? "\n" : " ")
      }
      if (js[i] === "`") put("`")
      continue
    }
    if (c === "{") { put(c); depth++; continue }
    if (c === "}") { depth = Math.max(0, depth - 1); put(c); continue }
    put(c)
  }

  return { text: out, depths }
}

// The problems with a cell's code (TypeScript as System Two wrote it), each with its line; none: it may run.
// `imports`: which module specifiers a cell may import ("kernel", or the scope file a library tool was saved with).
export const cellProblems = (code: string, imports: RegExp = /^kernel$/): ReadonlyArray<string> => {
  let paths: ReadonlyArray<string>
  try { paths = new Bun.Transpiler({ loader: "ts" }).scan(code).imports.map((i) => i.path) } catch { return [] } // the syntax check reports it
  const problems: Array<string> = []

  const outside = paths.filter((p) => !imports.test(p))
  if (outside.length) problems.push(`imports from ${[...new Set(outside)].join(", ")}: a cell imports only from "kernel" (Effect, the built-ins and earlier cells' definitions)`)

  const { text, depths } = blank(code)
  const lineAt = (at: number) => text.slice(0, at).split("\n").length

  // A name followed by ":" is an object's key ({ fetch: 1 }), not the global.
  for (const rule of RULES) {
    const m = [...text.matchAll(new RegExp(rule.pattern.source, "g"))].find((m) => !/^\s*:(?!:)/.test(text.slice(m.index! + m[0].length)))
    if (m) problems.push(`line ${lineAt(m.index!)}: ${m[0].trim()}: ${rule.say}`)
  }

  // The top level only defines things: no await there (work that runs every time the cell is imported), no let or var.
  const topLevel = (word: RegExp) => [...text.matchAll(word)].find((m) => depths[m.index!] === 0)
  const awaited = topLevel(/\bawait\b/g), mutable = topLevel(/\b(let|var)\b/g)
  if (awaited) problems.push(`line ${lineAt(awaited.index!)}: await at the top level: work at the top level runs every time the cell is imported; do it inside an Effect (the default export, or a function), and remember(...) what's costly`)
  if (mutable) problems.push(`line ${lineAt(mutable.index!)}: ${mutable[1]} at the top level: the top level only defines things (const); keep state inside an Effect (Ref)`)

  return problems
}
