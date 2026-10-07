import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Data, Effect } from "effect"
import { EMPTY_VESSEL_HOME } from "./home"

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

// The project's instructions as System Two is given them (Pi's format), one block per file, most general first. The
// loop puts them in the briefing it hands to System Two, whichever backend it is (Codex, or claude -p, which doesn't
// load CLAUDE.md itself when started with --setting-sources "").
export const projectInstructions = (cwd: string) =>
  loadContextFiles(cwd).pipe(Effect.map((files) => files.map((f) => `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`).join("\n\n")))
