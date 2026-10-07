import { Context, Effect } from "effect"

// What the loop reports while it works: a kind (so a UI can style or count it), how deep the agent is, and the text.
// `step`: System One picked a step · `system-two`: a command System Two ran · `check`: a check System One judged or saved ·
// `compact`, `review`: compaction and the review gate / reviewer · `spawn`: a sub-agent started · `error`: a system failed ·
// `note`: System Two telling the user something mid-run (tell_user), shown as its own line, never folded ·
// `activity`: what's happening right now (System One choosing, System Two thinking), for a live display only, never printed.
// `summary`: a cell’s plain-language intent, shown by quiet live-progress transports instead of its code title.
// `body`: more to show on request (a script, an edit's diff, a command's output); the TUI folds it.
export type Kind = "step" | "system-two" | "check" | "compact" | "review" | "spawn" | "error" | "activity" | "note"
type Event = { readonly kind: Kind; readonly depth: number; readonly text: string; readonly body?: string; readonly summary?: string }

// Where events go. By default they're printed, as before (indented by depth; errors to stderr). The TUI swaps this.
export const Events = Context.Reference<{ readonly emit: (event: Event) => Effect.Effect<void> }>("empty-vessel/Events", {
  defaultValue: () => ({
    emit: (e) => Effect.sync(() => { if (e.kind !== "activity") (e.kind === "error" ? console.error : console.log)(`${"  ".repeat(e.depth)}${e.text}`) }),
  }),
})

export const emit = (kind: Kind, depth: number, text: string, body?: string, summary?: string) =>
  Effect.gen(function* () { yield* (yield* Events).emit({ kind, depth, text, ...(body ? { body } : {}), ...(summary ? { summary } : {}) }) })
