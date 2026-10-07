import { join } from "node:path"
import { Effect } from "effect"
import { projectDir } from "../base/project"
import { loadChecks } from "./checks"
import { environment } from "./environment"
import { Config } from "../base/config"
import { EMPTY_VESSEL_HOME } from "../base/home"
import { Memory, type Scope, SCOPES } from "../base/memory"

// The latest notes for this project (open items, repeated failures), to show when a session starts.
export const recentNotes = (root: string, n = 5) =>
  Effect.promise(() => Bun.file(join(projectDir(root), "notes.jsonl")).text().catch(() => "")).pipe(
    Effect.map((text) => text.trim().split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l) as { kind: string; text: string })),
  )

// empty-vessel memory (and /memory): what's remembered, per scope, numbered, with how full each is; `remove <scope> <n>`
// forgets one entry; `edit [scope]` opens its file in $EDITOR when `canEdit` (the command line, not inside the TUI),
// else says where it is. Everything goes through the Memory service, so its limits hold.
export const memoryCommand = (args: string, canEdit = false) =>
  Effect.gen(function* () {
    const memory = yield* Memory
    const { memory: limits } = yield* Config
    const limit: Record<Scope, number> = { agent: limits.agentChars, project: limits.projectChars }
    const [what = "", scopeArg = "", n = ""] = args.trim().split(/\s+/)
    const scope = scopeArg as Scope
    const where = (s: Scope) => Effect.map(memory.file(s), (key) => join(EMPTY_VESSEL_HOME, key))

    if (what === "remove") {
      if (!SCOPES.includes(scope)) return `which scope? empty-vessel memory remove <${SCOPES.join(" | ")}> <n>`
      const entry = (yield* memory.entries(scope))[Number(n) - 1]
      if (!entry) return `no entry ${n} in ${scope} memory (empty-vessel memory lists them)`

      const refused = yield* memory.remove(scope, entry.replace(/^- /, "")).pipe(Effect.as(undefined), Effect.catch((e) => Effect.succeed(e.message)))
      return refused ? `not removed: ${refused}` : `forgot (${scope}): ${entry.replace(/^- /, "")}`
    }

    if (what === "edit") {
      const file = yield* where(SCOPES.includes(scope) ? scope : "project")
      const editor = process.env.VISUAL || process.env.EDITOR
      if (!canEdit || !editor) return `edit it here: ${file}${canEdit ? " (set $EDITOR to open it)" : ""}; keep one "- " line per entry`

      yield* Effect.promise(() => Bun.spawn([...editor.split(" "), file], { stdio: ["inherit", "inherit", "inherit"] }).exited)
      return `saved ${file}`
    }

    // The list: each scope, how full, its entries numbered (the ones remove takes).
    const parts = yield* Effect.forEach(SCOPES, (s) => Effect.gen(function* () {
      const entries = yield* memory.entries(s)
      const used = entries.reduce((sum, l) => sum + l.length + 1, 0)
      const head = `${s} (${used} of ${limit[s]} characters) · ${yield* where(s)}`
      return [head, ...(entries.length ? entries.map((e, i) => `  ${i + 1}. ${e.replace(/^- /, "")}`) : ["  (nothing yet)"])].join("\n")
    }))
    return [...parts, "", "empty-vessel memory remove <scope> <n> · empty-vessel memory edit [scope]"].join("\n")
  })

// What System Two is told at the start of a session: what the project runs on (src/learning/environment.ts), what empty-vessel
// remembers (this agent, this project), and the saved checks it can run by name. The loop hands it over, so System Two
// needn't know where learning keeps things.
export const briefing = (root: string) =>
  Effect.gen(function* () {
    const env = yield* environment(root)
    const learned = yield* (yield* Memory).snapshot
    const saved = yield* loadChecks(root)

    return [
      ...(env ? [env] : []),
      ...(learned ? [`<learned_in_earlier_sessions>\n${learned}\n</learned_in_earlier_sessions>`] : []),
      ...(saved.length ? [`<saved_checks>\nChecks that worked in earlier sessions. Run one with yield_to_system_one { check: { name, args } }:\n${saved.map((c) => `- ${c.name}: ${c.template} (${c.description})`).join("\n")}\n</saved_checks>`] : []),
    ].join("\n\n")
  })
