import { existsSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { appendHistory, withLock, writeAtomic } from "../base/files"
import { EMPTY_VESSEL_HOME } from "../base/home"
import { projectDir } from "../base/project"

// A saved check: a pass/fail command System Two worked out once, kept so it doesn't have to work it out again.
// `template` has named slots, e.g. "npx jest test/plugin/{plugin}.test.js --runInBand".
const Check = Schema.Struct({
  name: Schema.String,
  description: Schema.String, // what System Two (and later System One) reads to decide when to use it
  template: Schema.String,
  requires: Schema.optionalKey(Schema.Array(Schema.String)), // general checks: files that must exist for it to apply
  passes: Schema.Number,
  failsInARow: Schema.Number, // 3 → retired
})
type Check = typeof Check.Type
export type Scoped = Check & { readonly scope: "project" | "general" }

// A checks file, or [] if it's missing or unreadable (a broken file must never stop a turn).
const readChecks = (file: string) =>
  Effect.tryPromise(() => Bun.file(file).json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Check))),
    Effect.orElseSucceed((): ReadonlyArray<Check> => []),
  )

// The checks that apply here: general ones whose `requires` files exist, then project ones (same name → project wins).
export const loadChecks = (root: string, home = EMPTY_VESSEL_HOME) =>
  Effect.gen(function* () {
    const general = (yield* readChecks(join(home, "checks.json"))).filter((c) => (c.requires ?? []).every((f) => existsSync(join(root, f))))
    const project = yield* readChecks(join(projectDir(root, home), "checks.json"))

    const byName = new Map<string, Scoped>()
    for (const c of general) byName.set(c.name, { ...c, scope: "general" })
    for (const c of project) byName.set(c.name, { ...c, scope: "project" })
    return [...byName.values()].filter((c) => c.failsInARow < 3)
  })

// A slot's value: one argument, or a list (e.g. several test files), where each item is its own argument.
export type Slot = string | ReadonlyArray<string>
const items = (v: Slot) => (typeof v === "string" ? [v] : v)
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

// The command for a check: each {slot} filled with its argument(s), each shell-quoted, so an argument can't add commands.
export const fillTemplate = (template: string, args: Readonly<Record<string, Slot>>) => {
  const missing = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).filter((k) => args[k] === undefined)
  if (missing.length) return { missing }
  return { command: template.replace(/\{(\w+)\}/g, (_, k: string) => items(args[k]!).map(quote).join(" ")) }
}

// What System Two asks to keep when a check passes: the command as a template, and the values it used this time.
export type SaveAs = { readonly name: string; readonly description: string; readonly template: string; readonly args: Readonly<Record<string, Slot>>; readonly scope: "project" | "general"; readonly requires?: ReadonlyArray<string> }

// Code's checks before saving (maker ≠ checker). Returns why it's refused, or undefined if it may be saved.
export const vetCheck = (save: SaveAs, command: string, root: string) => {
  const raw = save.template.replace(/\{(\w+)\}/g, (_, k: string) => (save.args[k] === undefined ? `{${k}}` : items(save.args[k]!).join(" ")))
  if (raw !== command) return "the template filled with args isn't the command that passed"

  if (/\|\|\s*true|;\s*exit 0|--passWithNoTests/.test(save.template)) return "a check must be able to fail"
  if (/(^|[\s;&|])(sed -i|rm|mv|cp|tee)\s|>/.test(save.template)) return "a check may only run things, not change files"
  if (/&&|;|\|\|/.test(save.template)) return "one command per check (no &&, ;, ||), so each stays reusable on its own"
  if (save.scope === "general" && save.template.split(/\s+/).some((w) => w.includes("/") && existsSync(join(root, w.replace(/\{\w+\}.*/, ""))))) return "a general check can't name paths in this repo"
  return undefined
}

// Save (or replace, by name) a check that just passed, in its scope's file. Locked, written atomically, and logged
// in checks.log.jsonl (`source`: who asked, e.g. "save_as" or "reviewer"), since several agents may save at once.
export const saveCheck = (root: string, save: SaveAs, source: string, home = EMPTY_VESSEL_HOME) =>
  Effect.gen(function* () {
    const dir = save.scope === "project" ? projectDir(root, home) : home
    const file = join(dir, "checks.json")
    const check: Check = { name: save.name, description: save.description, template: save.template, ...(save.requires ? { requires: save.requires } : {}), passes: 1, failsInARow: 0 }

    yield* withLock(file, Effect.gen(function* () {
      const saved = (yield* readChecks(file)).filter((c) => c.name !== save.name)
      yield* writeAtomic(file, JSON.stringify([...saved, check], null, 2))
    }))

    yield* appendHistory(join(dir, "checks.log.jsonl"), { action: "save", scope: save.scope, check, source })
  })

// Remove a saved check by name (refine's undo, src/loop/refine.ts). Locked and written atomically, like saving.
export const removeCheck = (file: string, name: string) =>
  withLock(file, Effect.gen(function* () {
    yield* writeAtomic(file, JSON.stringify((yield* readChecks(file)).filter((c) => c.name !== name), null, 2))
  }))

// After a saved check is used: a pass counts, a "broken" run (the command itself didn't work) counts against it,
// and a plain "failed" (it ran and found problems, e.g. before the fix) says nothing about the check.
export const recordUse = (root: string, check: Scoped, verdict: string, home = EMPTY_VESSEL_HOME) =>
  Effect.gen(function* () {
    if (verdict !== "passed" && verdict !== "broken") return

    const dir = check.scope === "project" ? projectDir(root, home) : home
    const file = join(dir, "checks.json")
    const update = (c: Check): Check => (verdict === "passed" ? { ...c, passes: c.passes + 1, failsInARow: 0 } : { ...c, failsInARow: c.failsInARow + 1 })

    yield* withLock(file, Effect.gen(function* () {
      yield* writeAtomic(file, JSON.stringify((yield* readChecks(file)).map((c) => (c.name === check.name ? update(c) : c)), null, 2))
    }))

    if (verdict === "broken" && check.failsInARow + 1 >= 3) yield* appendHistory(join(dir, "checks.log.jsonl"), { action: "retire", name: check.name, source: "broken 3 times in a row" })
  })
