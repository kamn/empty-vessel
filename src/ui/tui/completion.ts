import { beforeCursor, type Draft } from "./edit"

export type Completion = { readonly command: string; readonly description: string; readonly skillName?: string }
export type CompletionState = Draft & {
  readonly completions: ReadonlyArray<Completion>
  readonly completionSelected: number
  readonly completionDismissed: boolean
  readonly running: boolean
  readonly asking: unknown
}

const MAX_FILES = 50
const MAX_LISTED = 20_000

// The project's files for @ completion: git's list (tracked, and new files it doesn't ignore), up to 20,000. Outside a
// git repo, none: walking an unknown folder (a home directory) at start could take minutes.
export const fileCompletions = (cwd: string): ReadonlyArray<Completion> => {
  const git = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, stdout: "pipe", stderr: "ignore" })
  if (git.exitCode !== 0) return []
  return [...new Set(git.stdout.toString().split("\0").filter(Boolean))].slice(0, MAX_LISTED).map((p) => ({ command: `@${p}`, description: "" }))
}

// The @path being typed at the cursor (the word before it, starting with @), if any.
const mentionAt = (prefix: string) => prefix.match(/(?:^|\s)(@\S*)$/)?.[1]

// Only the command prefix before the cursor participates. Arguments after it are never replaced.
// An @word at the cursor completes to the project's files (src/loop/mentions.ts): those whose path contains what's typed,
// the ones starting with it first, then the shortest.
export const suggestions = (model: CompletionState): ReadonlyArray<Completion> => {
  if (model.running || model.asking || model.completionDismissed) return []
  const prefix = beforeCursor(model)
  const mention = mentionAt(prefix)
  if (mention !== undefined) {
    const typed = mention.toLowerCase()
    const files = model.completions.filter((item) => item.command.startsWith("@") && item.command.toLowerCase().includes(typed.slice(1)))
    const rank = (item: Completion) => [Number(!item.command.toLowerCase().startsWith(typed)), item.command.length] as const
    return files.sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1]).slice(0, MAX_FILES)
  }

  if (!prefix.startsWith("/") || /[\n\r\t]/.test(prefix)) return []
  const candidates = prefix.startsWith("/skill ")
    ? model.completions.filter(item => item.skillName || item.command.startsWith("/skill ")).map(item => item.skillName ? { ...item, command: `/skill ${item.skillName}` } : item)
    : model.completions
  return candidates.filter((item) => item.command.startsWith(prefix)).sort((a, b) => Number(b.command === prefix) - Number(a.command === prefix))
}

export const selectedCompletion = (model: CompletionState, items = suggestions(model)) =>
  items[Math.max(0, Math.min(model.completionSelected, items.length - 1))]

export const acceptCompletion = (model: Draft, item: Completion): Draft => {
  const prefix = beforeCursor(model)
  const rest = model.input.slice(prefix.length)
  // Finish the token containing the cursor, not any following argument (including multiline arguments).
  const suffix = rest.replace(/^\S*/, "")
  // A file replaces only the @word it completes; a command, everything before the cursor.
  const head = item.command.startsWith("@") ? prefix.slice(0, prefix.length - (mentionAt(prefix)?.length ?? 0)) : ""
  return { input: head + item.command + suffix, after: Array.from(suffix).length }
}
