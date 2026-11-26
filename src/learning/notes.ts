import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { type Graph, retire } from "empty-graph"
import { projectDir } from "../base/project"
import { loadChecks } from "./checks"
import { environment } from "./environment"
import { Config } from "../base/config"
import { attrsOf, factsIn, GraphMemory, type NotesFile, stated } from "../base/graph-memory"
import { EMPTY_VESSEL_HOME } from "../base/home"
import { Memory, memoryLimits, type Scope, SCOPES, usedChars } from "../base/memory"

// The latest notes for this project (open items, repeated failures), to show when a session starts.
export const recentNotes = (root: string, n = 5) =>
  Effect.promise(() => Bun.file(join(projectDir(root), "notes.jsonl")).text().catch(() => "")).pipe(
    // A line cut short (a crash mid-append) is skipped: it mustn't stop a session from starting.
    Effect.map((text) => text.trim().split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as { kind: string; text: string }] } catch { return [] } }).slice(-n)),
  )

// empty-vessel memory (and /memory): what's remembered, per scope, numbered, with how full each is; `remove <scope> <n>`
// forgets one entry; `edit [scope]` opens its file in $EDITOR when `canEdit` (the command line, not inside the TUI),
// else says where it is. Everything goes through the Memory service, so its limits hold.
export const memoryCommand = (args: string, canEdit = false) =>
  Effect.gen(function* () {
    const graph = yield* Effect.serviceOption(GraphMemory)
    if (Option.isSome(graph)) return yield* graphCommand(graph.value, args, canEdit)
    const memory = yield* Memory
    const limit = memoryLimits((yield* Config).memory)
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
      const head = `${s === "user" ? "user profile" : s} (${usedChars(entries)} of ${limit[s]} characters) · ${yield* where(s)}`
      return [head, ...(entries.length ? entries.map((e, i) => `  ${i + 1}. ${e.replace(/^- /, "")}`) : ["  (nothing yet)"])].join("\n")
    }))
    return [...parts, "", "empty-vessel memory remove <scope> <n> · empty-vessel memory edit [scope]"].join("\n")
  })

// /memory over the graph (KTD17): the facts true now the active agent sees, by file, each with the start of its id;
// `remove <id>` retires one, `add <text>` keeps a fact about the user that the user stated, and `edit` opens the export
// in $EDITOR and on save retires the facts of removed lines and keeps added lines as facts the user stated (in the
// scope of the heading they're under).
const graphCommand = (gm: GraphMemory["Service"], args: string, canEdit: boolean) =>
  Effect.gen(function* () {
    const [what = "", ...rest] = args.trim().split(/\s+/)
    const text = rest.join(" ")
    const files = yield* gm.files
    const listed = (g: Graph) => files.map((file) => ({ file, facts: factsIn(g, file.filter) }))
    const refused = (e: { message: string }) => Effect.succeed(`not changed: ${e.message}`)

    if (what === "remove") return yield* gm.use((g) => {
      const found = listed(g).flatMap((l) => l.facts).filter((f) => text && f.id.startsWith(text))
      if (found.length !== 1) return `${found.length ? "several facts start" : "no fact starts"} with "${text}" (empty-vessel memory lists them)`
      retire(g, found[0]!.id)
      return `forgot: ${found[0]!.text}`
    }).pipe(Effect.catch(refused))

    if (what === "add") {
      if (!text) return "what should be remembered? empty-vessel memory add <text>"
      return yield* gm.use((g) => `remembered (user): ${stated(g, text, attrsOf(files.find((f) => f.scope === "user")!)).text}`).pipe(Effect.catch(refused))
    }

    if (what === "edit") {
      const editor = process.env.VISUAL || process.env.EDITOR
      if (!canEdit || !editor) return `edit needs the command line and $EDITOR: run empty-vessel memory edit there${canEdit ? " (set $EDITOR first)" : ""}`
      return yield* editGraph(gm, files, editor).pipe(Effect.catch(refused))
    }

    const parts = yield* gm.use((g) => listed(g).map(({ file, facts }) =>
      [`${file.label} (${file.scope})`, ...(facts.length ? facts.map((f) => `  ${f.id.slice(0, 8)} ${f.text}`) : ["  (nothing yet)"])].join("\n")))
    return [...parts, "", "empty-vessel memory remove <id> · empty-vessel memory add <text> · empty-vessel memory edit"].join("\n")
  })

// The export as one file, a "# <key>" heading per file the active agent sees; what changed is read back per heading.
const editGraph = (gm: GraphMemory["Service"], files: ReadonlyArray<NotesFile>, editor: string) =>
  Effect.gen(function* () {
    const lines = (text: string) => text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim())
    const before = yield* gm.use((g) => files.map((file) => ({ file, facts: factsIn(g, file.filter) })))
    const doc = before.map(({ file, facts }) => [`# ${file.key}`, ...facts.map((f) => `- ${f.text}`), ""].join("\n")).join("\n")
    const dir = mkdtempSync(join(tmpdir(), "empty-vessel-memory-")), path = join(dir, "memory.md")

    yield* Effect.promise(() => Bun.write(path, doc))
    yield* Effect.promise(() => Bun.spawn([...editor.split(" "), path], { stdio: ["inherit", "inherit", "inherit"] }).exited)
    const saved = yield* Effect.promise(() => Bun.file(path).text())
    rmSync(dir, { recursive: true, force: true })

    // Per heading: a line gone retires one fact with that text; a new line is kept as the user stated it. A heading gone
    // changes nothing (rather than forget a whole file to a slip).
    const after = new Map(saved.split(/^# /m).slice(1).map((section) => [section.split("\n")[0]!.trim(), lines(section)] as const))
    return yield* gm.use((g) => {
      let forgot = 0, kept = 0

      for (const { file, facts } of before) {
        const now = [...(after.get(file.key) ?? facts.map((f) => f.text))]
        for (const f of facts) {
          const i = now.indexOf(f.text)
          if (i >= 0) now.splice(i, 1)
          else { retire(g, f.id); forgot++ }
        }
        for (const text of now) { stated(g, text, attrsOf(file)); kept++ }
      }

      return `${forgot} forgotten, ${kept} remembered`
    })
  })

// What System Two is told at the start of a session: what the project runs on (src/learning/environment.ts), what empty-vessel
// remembers (the user, this agent, this project), and the saved checks it can run by name. The loop hands it over, so System Two
// needn't know where learning keeps things.
export const briefing = (root: string) =>
  Effect.gen(function* () {
    const env = yield* environment(root)
    // With the graph, facts reach a turn only through the pull (KTD12): this briefing is cached once per conversation.
    const learned = Option.isSome(yield* Effect.serviceOption(GraphMemory)) ? "" : yield* (yield* Memory).snapshot
    const saved = yield* loadChecks(root)

    return [
      ...(env ? [env] : []),
      ...(learned ? [`<learned_in_earlier_sessions>\n${learned}\n</learned_in_earlier_sessions>`] : []),
      ...(saved.length ? [`<saved_checks>\nChecks that worked in earlier sessions. Run one with yield_to_system_one { check: { name, args } }:\n${saved.map((c) => `- ${c.name}: ${c.template} (${c.description})`).join("\n")}\n</saved_checks>`] : []),
    ].join("\n\n")
  })
