import { beforeCursor, type Draft } from "./edit"

export type Completion = { readonly command: string; readonly description: string; readonly skillName?: string }
export type CompletionState = Draft & {
  readonly completions: ReadonlyArray<Completion>
  readonly completionSelected: number
  readonly completionDismissed: boolean
  readonly running: boolean
  readonly asking: unknown
}

// Only the command prefix before the cursor participates. Arguments after it are never replaced.
export const suggestions = (model: CompletionState): ReadonlyArray<Completion> => {
  if (model.running || model.asking || model.completionDismissed) return []
  const prefix = beforeCursor(model)
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
  return { input: item.command + suffix, after: Array.from(suffix).length }
}
