// System Two's thread is a list of Codex items: messages ({ role, content }), and { type: "function_call" |
// "function_call_output" | "reasoning" | "message", … }. These plain functions read and shorten it for compaction.

import { cellTitle } from "./dispatch"

type Item = { readonly type?: string; readonly role?: string; readonly call_id?: string; readonly name?: string; readonly arguments?: string; output?: unknown; content?: Array<{ type: string; text?: string }> }

// Where the last turn starts: the last message from the user. Everything from there on is kept as it is. Messages the
// loop adds in the middle of a run (the user steering, a jobs reminder, a tool's images, a stop note) don't start a turn.
const MID_RUN = ["[The user, while you work:", "Before you finish: these sub-agent jobs", "The images the tool calls above returned:", "(The user stopped your work"]
export const lastTurnStart = (thread: ReadonlyArray<unknown>) => {
  for (let i = thread.length - 1; i >= 0; i--) {
    const item = thread[i] as Item
    if (item.role === "user" && !MID_RUN.some((p) => (item.content?.[0]?.text ?? "").startsWith(p))) return i
  }
  return 0
}

// The message a summary (tier 2) replaces everything before the last turn with.
export const SUMMARY_START = "Summary of the conversation so far (older messages were compacted):"

const STUB = "[compacted"
const CELL = "[cell "

// Files gather put in a user message: <file path="…">…</file>.
const FILE_BLOCK = /<file path="([^"]+)">\n([\s\S]*?)\n<\/file>/g

// Files gather put in user messages before the last turn (empty-vessel's biggest content), long and not already a stub.
export type OldFile = { readonly index: number; readonly file: string }
export const oldFiles = (thread: ReadonlyArray<unknown>, before: number, minChars = 500) =>
  thread.slice(0, before).flatMap((raw, index) =>
    [...((raw as Item).role === "user" ? ((raw as Item).content?.[0]?.text ?? "") : "").matchAll(FILE_BLOCK)]
      .filter(([, , text]) => text!.length >= minChars && !text!.startsWith(STUB))
      .map(([, path]): OldFile => ({ index, file: path! })))

// Swap one gathered file for a one-line stub; the full text goes in `stash` so more_output can bring it back.
// Returns how many characters that took out of the thread.
export const stubFile = (thread: Array<unknown>, old: OldFile, stash: Map<string, string>) => {
  const item = thread[old.index] as Item
  const id = `out${stash.size + 1}`
  let saved = 0

  const text = (item.content?.[0]?.text ?? "").replace(FILE_BLOCK, (block, path: string, full: string) => {
    if (path !== old.file || full.startsWith(STUB)) return block
    const stub = `${STUB}: ${full.split("\n").length} lines. If you need it: more_output { id: "${id}" }]`
    stash.set(id, full)
    saved = full.length - stub.length
    return `<file path="${path}">\n${stub}\n</file>`
  })
  thread[old.index] = { ...item, content: [{ ...item.content![0]!, text }, ...item.content!.slice(1)] }
  return saved
}

// A kernel cell before the last turn, big enough to compress: its call and output (by index), its code, what it was for
// (its title), and a glimpse of the output (first and last lines) for the result summary.
export type OldCell = { readonly call: number; readonly output: number; readonly code: string; readonly intent: string; readonly glimpse: string }
export const oldCells = (thread: ReadonlyArray<unknown>, before: number, minChars = 500) => {
  const outputs = new Map(thread.slice(0, before).flatMap((raw, i) => (raw as Item).type === "function_call_output" ? [[(raw as Item).call_id, i] as const] : []))
  const found: Array<OldCell> = []

  thread.slice(0, before).forEach((raw, call) => {
    const item = raw as Item
    const output = outputs.get(item.call_id)
    if (item.type !== "function_call" || item.name !== "kernel" || output === undefined) return
    const args = parse(item.arguments)
    const out = String((thread[output] as Item).output ?? "")
    if (typeof args.code !== "string" || out.startsWith(CELL) || args.code.length + out.length < minChars) return
    found.push({ call, output, code: args.code, intent: cellTitle(args).slice(0, 100), glimpse: glimpseOf(out) })
  })

  return found
}

// Rewrite one cell to a line: its call keeps call_id and summary (its code points at the stash), its output becomes
// "[cell outN · intent · lines · result: …]". `result`: the fill model's summary, else the output's first line.
// Source and output go in `stash` under the id. Returns how many characters that took out of the thread.
export const compressCell = (thread: Array<unknown>, cell: OldCell, result: string | undefined, stash: Map<string, string>) => {
  const call = thread[cell.call] as Item, output = thread[cell.output] as Item
  const out = String(output.output ?? "")
  const id = `out${stash.size + 1}`

  const args = JSON.stringify({ summary: cell.intent, code: `[compacted: more_output { id: "${id}" }]` })
  const said = (result ?? out.split("\n").find((l) => l.trim()) ?? "(no output)").replace(/\s+/g, " ").trim().slice(0, 200)
  const line = `${CELL}${id} · ${cell.intent} · ${out.split("\n").length} lines · result: ${said}]`
  stash.set(id, `${cell.code}\n── result ──\n${out}`)
  thread[cell.call] = { ...call, arguments: args }
  thread[cell.output] = { ...output, output: line }

  return String(call.arguments ?? "").length + out.length - args.length - line.length
}

// Reasoning items (Codex's encrypted thinking) before the last turn: it only needs the ones in the current chain of
// tool calls. Removes them in place; returns how many.
export const dropOldReasoning = (thread: Array<unknown>, before: number) => {
  const kept = thread.slice(0, before).filter((t) => (t as Item).type !== "reasoning")
  const dropped = before - kept.length
  thread.splice(0, before, ...kept)
  return dropped
}

// What a summary leaves reopenable: compressed cells, stubbed files and an earlier summary's own list, in `items`.
// "- outN: what it is" lines, newest first, at most `max` (older ids stay in the stash and the session's records).
export const reopenIndex = (items: ReadonlyArray<unknown>, max = 100) => {
  const found = new Map<number, string>()

  for (const raw of items) {
    const item = raw as Item
    if (item.type === "function_call_output" && typeof item.output === "string")
      for (const [, n, what] of item.output.matchAll(/^\[cell out(\d+) · (.+?) · \d+ lines · /g)) found.set(Number(n), what!)
    if (item.role !== "user") continue
    const text = item.content?.[0]?.text ?? ""

    for (const [, path, stub] of text.matchAll(FILE_BLOCK)) {
      const n = stub!.startsWith(STUB) ? stub!.match(/id: "out(\d+)"/)?.[1] : undefined
      if (n) found.set(Number(n), `file ${path}`)
    }
    if (text.startsWith(SUMMARY_START)) for (const [, n, what] of text.matchAll(/^- out(\d+): (.+)$/gm)) found.set(Number(n), what!)
  }

  const lines = [...found].sort(([a], [b]) => b - a).slice(0, max).map(([n, what]) => `- out${n}: ${what}`)
  return lines.length ? `\n\nStill reopenable with more_output (newest first):\n${lines.join("\n")}` : ""
}

const parse = (args: string | undefined): { code?: unknown; summary?: unknown } => {
  try { return JSON.parse(args ?? "{}") ?? {} } catch { return {} }
}
// First and last 4 lines, at most 600 characters: where a command's start and its verdict are.
const glimpseOf = (out: string) => {
  const lines = out.split("\n")
  const shown = lines.length <= 8 ? lines : [...lines.slice(0, 4), `[… ${lines.length - 8} lines …]`, ...lines.slice(-4)]
  return shown.join("\n").slice(0, 600)
}

// Pi's compaction summary: what the model needs to carry on, in a fixed shape.
export const SUMMARY_REQUEST = [
  "Summarize the conversation so far so you can continue from the summary alone; the messages above it will be removed.",
  "Use exactly these sections, short and factual:",
  "## Goal — what the user wants overall",
  "## Constraints & preferences — rules the user gave",
  "## Progress — done / in progress / blocked",
  "## Key decisions — and why",
  "## Next steps",
  "## Critical context — files touched, commands that work (and ones that didn't), exact names and values you'll need",
].join("\n")

// After a turn was stopped partway (Ctrl+C): drop reasoning left at the end without the item it led to (the API
// rejects that), and tell System Two what happened, since the stopped run may already have changed files.
export const noteStop = (thread: Array<unknown>, request: string) => {
  while (thread.length && (thread.at(-1) as Item).type === "reasoning") thread.pop()
  const note = `(The user stopped your work on "${request.slice(0, 200)}" partway. Files may already have been changed.)`
  thread.push({ role: "user", content: [{ type: "input_text", text: note }] })
}
