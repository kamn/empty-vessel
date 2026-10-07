import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { Line, Model } from "./app"

// Deliberately independent of the conversation/kernel runtime: loading never imports or runs a cell.
const SNAPSHOT = "tui-view.json"
const VERSION = 1

type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value)
const string = (value: unknown): value is string => typeof value === "string"
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string)
const pairs = (value: unknown, second: string) => Array.isArray(value) && value.every((item) => object(item) && string(item.label) && string(item[second]))
const line = (value: unknown): value is Line => object(value) && string(value.kind) && string(value.text)
  && ["body", "summary"].every((key) => value[key] === undefined || string(value[key]))
  && ["open", "sourceOpen", "resultOpen"].every((key) => value[key] === undefined || typeof value[key] === "boolean")

// Reject a partial/unknown snapshot rather than mixing incompatible drafts and paste tables.
const model = (value: unknown): value is Model => {
  if (!object(value)) return false
  const question = value.asking

  return ["input", "activity", "status", "total", "questionDraft"].every((key) => string(value[key]))
    && ["after", "historyAt", "frame", "scrollBack", "selectedOption"].every((key) => integer(value[key]))
    && ["running", "stopping", "exiting"].every((key) => typeof value[key] === "boolean")
    && ["history", "queued", "steering"].every((key) => strings(value[key]))
    && pairs(value.attached, "path") && pairs(value.pastes, "text")
    && Array.isArray(value.printed) && value.printed.every(line)
    && (question === null || (object(question) && string(question.question) && strings(question.options)))
    && (value.after as number) <= (value.input as string).length
    && (value.historyAt as number) <= (value.history as string[]).length
    && (question === null || (value.selectedOption as number) <= (question.options as string[]).length)
}

const idle = (view: Model): Model => {
  const printed = [...view.printed]

  if (view.running || view.stopping) printed.push({ kind: "info", text: "Previous activity was interrupted; nothing has been restarted." })

  if (view.asking) {
    const choice = view.asking.options[view.selectedOption]
    printed.push({ kind: "note", text: ["Unanswered question (not resumed):", view.asking.question,
      ...view.asking.options.map((option) => `• ${option}`),
      ...(choice === undefined ? [] : [`Selected (not sent): ${choice}`]),
      ...(view.input ? [`Unsent answer/note: ${view.input}`] : []),
    ].join("\n") })
  } else if (view.questionDraft) {
    printed.push({ kind: "note", text: `Recovered question draft (not sent):\n${view.questionDraft}` })
  }

  for (const text of view.queued) printed.push({ kind: "note", text: `Previously queued (not sent):\n${text}` })

  for (const text of view.steering) {
    // Steering is normally already printed by app.ts; only recover text not already visible.
    if (!printed.some((item) => item.kind === "user" && item.text === text)) {
      printed.push({ kind: "note", text: `Pending steering (not resent):\n${text}` })
    }
  }

  return { ...view, printed, input: view.asking ? view.questionDraft : view.input, after: view.asking ? 0 : view.after,
    queued: [], steering: [], running: false, stopping: false, activity: "", frame: 0,
    asking: null, selectedOption: 0, questionDraft: "", exiting: false }
}

const read = (path: string): string | undefined => {
  try { return readFileSync(path, "utf8") } catch { return undefined }
}
const parse = (text: string | undefined): unknown => {
  try { return text === undefined ? undefined : JSON.parse(text) } catch { return undefined }
}

// Only explicit public records are replayed. `thread`, `stash`, `step` (debug results), child files,
// and kernel result files are NOT chat history. The index enriches recorded cells, never adds duplicates.
const replay = (dir: string, initial: Model): Model => {
  const printed = [...initial.printed]
  const history = [...initial.history]
  const index = parse(read(join(dir, "kernel", "index.json")))
  const cells = Array.isArray(index) ? index.filter(object) : []

  for (const raw of (read(join(dir, "main.jsonl")) ?? "").split("\n")) {
    const entry = parse(raw)
    if (!object(entry) || !string(entry.text)) continue

    if (entry.role === "user" || entry.role === "assistant" || entry.role === "steer") {
      printed.push({ kind: entry.role === "assistant" ? "reply" : "user", text: entry.text })
      if (entry.role === "user") history.push(entry.text)
      continue
    }

    if (entry.role !== "command") continue
    const args = object(entry.args) ? entry.args : parse(string(entry.args) ? entry.args : undefined)
    if (!object(args)) continue

    if (entry.text === "tell_user" && string(args.message)) {
      // File captions are delivered by the transport, not emitted as TUI notes.
      if (!args.file) printed.push({ kind: "note", text: args.message })
      continue
    }

    if (entry.text !== "kernel") continue
    const source = string(args.code) ? args.code : string(args.text) ? args.text : undefined
    if (source === undefined) continue
    const output = string(entry.output) ? entry.output : "(recorded output unavailable)"
    const number = output.match(/^cell (\d+):/m)?.[1]
    const cell = number === undefined ? undefined : cells.find((item) => item.n === Number(number))
    const summary = string(args.summary) ? args.summary : string(cell?.title) ? cell.title : undefined
    const title = string(args.text) ? `text ${string(args.name) ? args.name : "(no name)"} (${args.text.split("\n").length} lines)`
      : summary ?? source.replace(/import\s[^;]*?from\s*["'][^"']*["'];?/g, "").split("\n").find((row) => row.trim())?.trim().slice(0, 100) ?? "(empty cell)"

    printed.push({ kind: "system-two", text: `  system two ran: kernel: ${title}`,
      body: `${source}\n── result ──\n${output}`, ...(summary === undefined ? {} : { summary }) })
  }

  return idle({ ...initial, printed, history, historyAt: history.length })
}

/** Restore the view only, never executable state. Current launch status wins over stale status. */
export const loadView = (dir: string, initial: Model): Model => {
  try {
    const saved = parse(read(join(dir, SNAPSHOT)))
    if (object(saved) && saved.version === VERSION && model(saved.model)) {
      // Completions belong to the current skill catalog, not the saved session.
      return idle({ ...initial, ...saved.model, status: initial.status, completions: initial.completions,
        completionSelected: initial.completionSelected, completionDismissed: initial.completionDismissed })
    }
    return replay(dir, initial)
  } catch {
    return idle(initial)
  }
}

/** Same-directory rename exposes either the previous complete snapshot or the next complete snapshot.
 * Errors intentionally propagate: callers decide how to report a failed save. */
export const saveView = (dir: string, view: Model): void => {
  if (!model(view)) throw new Error("Invalid TUI view")
  const contents = JSON.stringify({ version: VERSION, model: view }) + "\n"
  mkdirSync(dir, { recursive: true })
  const temporary = join(dir, `.${SNAPSHOT}.${randomUUID()}.tmp`)

  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 })
    renameSync(temporary, join(dir, SNAPSHOT))
  } finally {
    try { unlinkSync(temporary) } catch { /* Renamed, or creation failed. Preserve the original error. */ }
  }
}
