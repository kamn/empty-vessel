// A setup lesson in a run's commands: a command failed, then the same command passed with an
// environment variable or PATH (a tool's version) set. Shared by `empty-vessel refine` (over a session's records) and the live
// nudge (src/system-two/dispatch.ts: the next tool result suggests saving it).

// A command's exit code from its output ("exit 1 …", or inside a cell's result); none said: 0.
export const exitOf = (output = "") => Number(output.match(/exit (\d+)/)?.[1] ?? 0)

const ASSIGNMENT = /\b[A-Z][A-Z0-9_]*=[^\s"'`;)]+/g
// The shell commands in a cell (its bash("…") calls) or a check (the command itself).
const commandsIn = (text: string) => {
  const calls = [...text.matchAll(/bash\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!)
  return calls.length ? calls : [text]
}
const bare = (command: string) => command.replace(ASSIGNMENT, "").replace(/\s+/g, " ").trim()

// The assignments (APP_MODE=test, PATH=…) that made `command` pass where the same command, without them, had failed;
// none: not a lesson. Failing again with them (another bug) doesn't hide the lesson.
export const lessonIn = (failed: ReadonlyArray<string>, command: string, output: string): ReadonlyArray<string> => {
  if (!failed.length || exitOf(output) !== 0) return []
  const before = failed.flatMap(commandsIn)

  return [...new Set(commandsIn(command).flatMap((c) => (c.match(ASSIGNMENT) ?? []).filter((v) =>
    before.some((f) => !f.includes(v) && bare(f) === bare(c)))))]
}
