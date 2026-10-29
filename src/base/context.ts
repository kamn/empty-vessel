import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Context, Data, Effect } from "effect"
import { EMPTY_VESSEL_HOME } from "./home"

// What the host running core (the background agent) tells System Two about itself, e.g. which channels the user
// reaches it on: in the briefing after the project's instructions. Plain core and the TUI have none.
export const HostBriefing = Context.Reference<string | undefined>("empty-vessel/HostBriefing", { defaultValue: () => undefined })

class ContextError extends Data.TaggedError("ContextError")<{ path: string; cause: unknown }> {}

const NAMES = ["AGENTS.md", "CLAUDE.md"] // in each folder, the first one found wins

// Folders to search, most general first: ~/.empty-vessel, then from the filesystem root down to cwd.
const folders = (cwd: string) => {
  const chain: string[] = []
  for (let dir = cwd; ; dir = dirname(dir)) {
    chain.unshift(dir)
    if (dirname(dir) === dir) break // reached the root: dirname("/") is "/"
  }
  return [EMPTY_VESSEL_HOME, ...chain]
}

// Every AGENTS.md / CLAUDE.md that applies here. They all stack; the closest folder comes last.
export const loadContextFiles = (cwd: string) =>
  Effect.forEach(
    folders(cwd).flatMap((dir) => {
      const name = NAMES.find((n) => existsSync(join(dir, n)))
      return name ? [join(dir, name)] : []
    }),
    (path) =>
      Effect.try({
        try: () => ({ path, content: readFileSync(path, "utf8") }),
        catch: (cause) => new ContextError({ path, cause }),
      }),
  )

// The AGENTS.md / CLAUDE.md of folders below `cwd` that hold any of `paths` (relative to cwd): a package's own rules in a
// monorepo, which loadContextFiles (cwd and above) never sees. Most general first; the first name found wins per folder.
export const nestedContextFiles = (cwd: string, paths: ReadonlyArray<string>) => {
  const dirs = new Set<string>()

  for (const path of paths) {
    for (let dir = dirname(path); dir !== "." && dir !== "/" && !dir.startsWith(".."); dir = dirname(dir)) dirs.add(dir)
  }

  return [...dirs].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)).flatMap((dir) => {
    const name = NAMES.find((n) => existsSync(join(cwd, dir, n)))
    return name ? [join(dir, name)] : []
  })
}

// The project's instructions as System Two is given them (Pi's format), one block per file, most general first. The
// loop puts them in the briefing it hands to System Two, whichever backend it is (Codex, or claude -p, which doesn't
// load CLAUDE.md itself when started with --setting-sources "").
export const projectInstructions = (cwd: string) =>
  loadContextFiles(cwd).pipe(Effect.map((files) => files.map((f) => `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`).join("\n\n")))
