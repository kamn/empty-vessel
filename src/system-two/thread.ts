// System Two's thread is a list of Codex items: messages ({ role, content }), and { type: "function_call" |
// "function_call_output" | "reasoning" | "message", … }. These plain functions read and shorten it for compaction.

type Item = { readonly type?: string; readonly role?: string; readonly call_id?: string; readonly name?: string; readonly arguments?: string; output?: unknown; content?: Array<{ type: string; text?: string }> }

// Where the last turn starts: the last message from the user. Everything from there on is kept as it is.
export const lastTurnStart = (thread: ReadonlyArray<unknown>) => {
  for (let i = thread.length - 1; i >= 0; i--) if ((thread[i] as Item).role === "user") return i
  return 0
}

const STUB = "[hidden by System One"

// Files gather put in a user message: <file path="…">…</file>.
const FILE_BLOCK = /<file path="([^"]+)">\n([\s\S]*?)\n<\/file>/g
const describeText = (text: string) => `${text.split("\n").length} lines, starting:\n${text.split("\n").slice(0, 3).join("\n")}`

// Old content worth hiding, from before the last turn: long tool outputs, and files gather put in user messages
// (empty-vessel's biggest content). Not already a stub. The label is what System One reads: what it is, how long, how it starts.
// `file`: which file block in a user message (by path); absent for a tool output.
export type Old = { readonly index: number; readonly label: string; readonly chars: number; readonly file?: string }
export const oldOutputs = (thread: ReadonlyArray<unknown>, before: number, minChars = 500) => {
  const calls = new Map((thread as ReadonlyArray<Item>).filter((t) => t.type === "function_call").map((t) => [t.call_id, t]))
  const found: Array<Old> = []

  thread.slice(0, before).forEach((raw, index) => {
    const item = raw as Item
    if (item.role === "user")
      for (const [, path, text] of (item.content?.[0]?.text ?? "").matchAll(FILE_BLOCK))
        if (text!.length >= minChars && !text!.startsWith(STUB)) found.push({ index, file: path!, label: `file ${path} (gathered) → ${describeText(text!)}`, chars: text!.length })
    if (item.type !== "function_call_output" || typeof item.output !== "string") return
    if (item.output.length < minChars || item.output.startsWith(STUB)) return
    const call = calls.get(item.call_id)
    const lines = item.output.split("\n")
    const label = `${call?.name ?? "tool"} ${(call?.arguments ?? "").slice(0, 200)} → ${lines.length} lines, starting:\n${lines.slice(0, 3).join("\n")}`
    found.push({ index, label, chars: item.output.length })
  })

  return found
}

// Swap a tool output (or one gathered file) for a one-line stub; the full text goes in `stash` so more_output can
// bring it back. Returns how many characters that took out of the thread.
export const maskOutput = (thread: Array<unknown>, old: Old, stash: Map<string, string>) => {
  const item = thread[old.index] as Item
  const stub = (full: string, id: string) => `${STUB} (no longer needed): ${full.split("\n").length} lines. If you need it: more_output { id: "${id}" }]`
  const id = `out${stash.size + 1}`

  if (old.file === undefined) {
    const full = String(item.output)
    stash.set(id, full)
    thread[old.index] = { ...item, output: stub(full, id) }
    return full.length - stub(full, id).length
  }

  let saved = 0
  const text = (item.content?.[0]?.text ?? "").replace(FILE_BLOCK, (block, path: string, full: string) => {
    if (path !== old.file || full.startsWith(STUB)) return block
    stash.set(id, full)
    saved = full.length - stub(full, id).length
    return `<file path="${path}">\n${stub(full, id)}\n</file>`
  })
  thread[old.index] = { ...item, content: [{ ...item.content![0]!, text }, ...item.content!.slice(1)] }
  return saved
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
