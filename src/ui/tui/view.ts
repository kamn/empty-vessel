import { suggestions } from "./completion"
import { type Line, type Model, PREVIEW } from "./app"
import { renderMarkdown } from "./markdown"
import { beforeCursor } from "./edit"
import { style, widthOf } from "./style"
import { isKernelCell, isThinking, renderCell, renderNotes, type CellRow } from "./cell"

// VIEW: a chronological, scrollable conversation log above the live input area.
// Events join the log as they arrive; the bottom area holds activity, questions, queued messages and status.
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"

// An event's first line as a title: a command System Two ran gets a ●, its thinking a ◆.
const title = (text: string, kind: string) => {
  const ran = text.match(/^(\s*)system two ran: (.*)$/)
  if (ran) return `${ran[1]}${style.tool("●")} ${ran[2]}`
  const thought = text.match(/^(\s*)thought: (.*)$/)
  if (thought) return `${thought[1]}${style.dim(`◆ ${style.italic(thought[2]!)}`)}`
  return kind === "step" ? style.step(text) : kind === "error" ? style.error(text) : style.dim(text)
}

// A body under its title: a diff's lines in red and green, anything else dim; cut to PREVIEW lines unless expanded.
const bodyLines = (body: string, pad: string, whole: boolean) => {
  const lines = body.split("\n")
  const shown = whole ? lines : lines.slice(0, PREVIEW)
  const paint = (l: string) => (l.startsWith("+ ") ? style.tool(l) : l.startsWith("- ") ? style.error(l) : style.dim(l))
  const more = lines.length - shown.length
  return [...shown.map((l) => `${pad}  ${style.dim("│")} ${paint(l)}`), ...(more ? [`${pad}  ${style.dim(`… ${more} more lines · click to expand`)}`] : [])]
}

export const printRows = (line: Line, width = 80): ReadonlyArray<CellRow> =>
  isKernelCell(line) ? renderCell(line, width) : printLine(line, width).map((text) => ({ text }))

export const printLine = (line: Line, width = 80): ReadonlyArray<string> => {
  if (isKernelCell(line)) return renderCell(line, width).map((row) => row.text)
  if (isThinking(line) || line.kind === "note") return renderNotes(line, width)
  const lines = line.text.split("\n")
  if (line.kind === "user") return ["", ...lines.map((l, i) => `${style.accent(i ? "  " : "› ")}${style.bold(style.user(l))}`)]
  if (line.kind === "reply") return ["", ...renderMarkdown(line.text, width), ""]
  if (line.kind === "usage" || line.kind === "info") return lines.map(style.dim)
  if (line.kind === "banner") return lines // the logo: already coloured

  // An event: a command with its script, diff or output; System Two's thinking; a step; a review.
  const pad = lines[0]!.match(/^\s*/)![0]
  const expanded = line.open === true
  const head = line.kind === "system-two" || expanded ? [`${pad}${expanded ? style.dim("▾ ") : ""}${title(lines[0]!.trimStart(), line.kind)}`] : lines.map((l) => title(l, line.kind))
  return [...head, ...(line.body ? bodyLines(line.body, pad, expanded) : [])]
}

// Cut plain text to a width (wide characters count 2), with … when cut.
const fit = (text: string, width: number) => {
  if (width <= 0) return ""
  if (widthOf(text) <= width) return text
  let out = ""
  for (const ch of text) if (widthOf(out + ch) < width) out += ch; else break
  return `${out}…`
}

// Split a line into pieces of at most `width` characters (the input box wraps; a long line isn't cut).
const wrap = (text: string, width: number) => {
  const chars = Array.from(text)
  return chars.length ? Array.from({ length: Math.ceil(chars.length / width) }, (_, i) => chars.slice(i * width, (i + 1) * width).join("")) : [""]
}

// While a turn runs: activity and queued messages. Events already live in the scrollable log.
const working = (model: Model, width: number) => {
  const now = `${style.step(SPINNER[model.frame % SPINNER.length]!)} ${fit(model.activity || "working…", width - 30)}`
  const queued = model.queued.map((q) => `  ${style.dim("⏵ queued:")} ${fit(q.replace(/\n/g, " "), width - 14)}`)
  return [`${now} ${style.dim(`· ${Math.floor(model.frame / 10)}s · Esc to stop`)}`, ...queued]
}

// Select already-wrapped conversation rows for the space above the input box.
export const conversationWindow = (rows: ReadonlyArray<string>, height: number, scrollBack: number) => {
  const available = Math.max(0, height)
  const maximum = Math.max(0, rows.length - available)
  const offset = Math.max(0, Math.min(scrollBack, maximum))
  const end = rows.length - offset

  return {
    rows: rows.slice(Math.max(0, end - available), end),
    offset,
  }
}

// The live area, and where the cursor goes in it: where it is in what's being typed, inside the box.
export const live = (model: Model, width: number, height = Infinity): { readonly lines: ReadonlyArray<string>; readonly cursor: { readonly row: number; readonly col: number } } => {
  const lines: Array<string> = [""]
  if (model.asking) lines.push(style.bold(fit(model.asking.question, width)), ...[...model.asking.options, "Other (type your answer)"].map((o, i) => `${i === model.selectedOption ? style.accent("❯") : " "} ${style.accent(`${i + 1}.`)} ${fit(o, width - 6)}`))
  if (model.running && !model.asking) lines.push(...working(model, width))

  // The box: │ › text │, the text padded to the inner width. Dim while a turn runs (what's typed then is queued).
  const inner = Math.max(1, width - 7) // one column spare: a line that fills the last column can wrap early on some terminals
  const border = model.running && !model.asking ? style.dim : style.accent
  const rows = model.input.split("\n").flatMap((l) => wrap(l, inner))
  const upToCursor = beforeCursor(model).split("\n").flatMap((l) => wrap(l, inner)) // the rows that end at the cursor
  const questionHint = model.asking && model.selectedOption === model.asking.options.length
    ? "Type your answer · ↑↓ select · Enter confirm"
    : "Optional note · ↑↓ select · Enter sends choice + note"
  const hint = model.asking ? questionHint : model.running ? "Type to queue a message for after this turn" : "Type a message · / commands · Enter to send · \\ Enter new line · Ctrl+V image · ↑ earlier · Ctrl+D leave"
  lines.push(border(`╭${"─".repeat(inner + 4)}╮`))

  for (const [i, row] of rows.entries()) {
    // An attached image's label ([Image #1]) in the accent colour: it stands for a file, it isn't typed text.
    const text = i === 0 && !model.input ? style.dim(fit(hint, inner)) : row.replace(/\[Image #\d+\]/g, (label) => style.accent(label))
    lines.push(`${border("│")} ${style.accent(i ? " " : "›")} ${text}${" ".repeat(Math.max(0, inner - widthOf(text)))} ${border("│")}`)
  }

  const cursor = { row: lines.length - rows.length + upToCursor.length - 1, col: 4 + widthOf(upToCursor.at(-1)!) }
  lines.push(border(`╰${"─".repeat(inner + 4)}╯`))
  const items = suggestions(model)
  const selected = Math.max(0, Math.min(model.completionSelected, items.length - 1))
  // Reserve footer rows; autocomplete must not push the input/cursor outside a short terminal.
  const count = Math.max(0, Math.min(5, height - lines.length - 1 - (model.total ? 1 : 0)))
  const first = Math.max(0, selected - Math.max(0, count - 1))
  for (const [offset, item] of items.slice(first, first + count).entries()) {
    const text = fit(`${first + offset === selected ? "❯" : " "} ${item.command}  ${item.description.replace(/[\r\n\t]/g, " ")}`, width)
    lines.push(first + offset === selected ? style.accent(text) : style.dim(text))
  }
  lines.push(style.dim(fit(`  ${model.status}`, width)))
  if (model.total) lines.push(style.dim(fit(`  ${model.total}`, width)))
  return { lines, cursor }
}
