import { hyperlink, style, widthOf } from "./style"

// Replies are markdown; this draws them for the terminal: headings, lists, quotes, rules, code blocks (lightly
// highlighted), simple pipe tables, and inline `code`, **bold**, *italic*, and links (clickable). Nesting stays as written.
// ponytail: line-by-line regexes, not a parser; swap in `marked` + a terminal renderer if replies need more.

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(((?:https?|file):\/\/[^)\s]+)\)|((?:https?|file):\/\/[^\s)>\]]+)|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|(?<!\w)_([^_\s][^_]*?)_(?!\w)/g

const inline = (text: string) =>
  text.replace(INLINE, (_, code, bold, label, url, bare, star, under) =>
    code !== undefined ? style.code(code)
    : bold !== undefined ? style.bold(bold)
    : label !== undefined ? style.link(style.underline(hyperlink(label, url)))
    : bare !== undefined ? style.link(style.underline(hyperlink(bare, bare)))
    : style.italic(star ?? under))

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

// Wrap visible words, retaining colours and clickable links on every physical row.
const wrapCell = (text: string, width: number): Array<string> => {
  const lines: string[] = []
  const end = "\x1b]8;;\x1b\\\x1b[0m"
  let row = "", codes = "", used = 0, space = false
  const flush = () => { lines.push(row + (codes ? end : "")); row = codes; used = 0; space = false }
  const tokens = text.match(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][\s\S]*?(?:\x07|\x1b\\)|[^\s\x1b]+|[ \t]+/g) ?? []

  for (const token of tokens) {
    if (token.startsWith("\x1b")) { row += token; codes += token; continue }
    if (/^\s+$/.test(token)) { space = used > 0; continue }
    if (used && used + Number(space) + widthOf(token) > width) flush()
    if (space) { row += " "; used++; space = false }

    for (const { segment } of graphemes.segment(token)) {
      const size = widthOf(segment)
      if (used && used + size > width) flush()
      row += segment
      used += size
    }
  }

  return [...lines, row + (codes ? end : "")]
}

// Rows contain cells only; the Markdown separator row is excluded.
const renderTable = (rows: ReadonlyArray<ReadonlyArray<string>>, width: number): Array<string> => {
  const styled = rows.map((row) => row.map(inline))
  const widths = rows[0]!.map((_, column) =>
    Math.max(3, ...styled.map((row) => widthOf(row[column] ?? ""))))
  // Borders and padding cost three columns per cell, plus the final border.
  const available = width - widths.length * 3 - 1

  if (available < widths.length * 3) {
    if (styled.length === 1) return styled[0]!.flatMap((cell) => wrapCell(cell, width))

    return styled.slice(1).flatMap((row, index) => [
      ...(index ? [""] : []),
      ...row.flatMap((cell, column) => wrapCell(`${styled[0]![column]}: ${cell}`, width)),
    ])
  }

  while (widths.reduce((sum, size) => sum + size, 0) > available) {
    const widest = widths.indexOf(Math.max(...widths))
    widths[widest]!--
  }

  const border = (left: string, middle: string, right: string) =>
    left + widths.map((width) => "─".repeat(width + 2)).join(middle) + right
  const output: Array<string> = [border("┌", "┬", "┐")]

  for (const [index, row] of styled.entries()) {
    const wrapped = widths.map((size, column) => wrapCell(row[column] ?? "", size))

    for (let line = 0; line < Math.max(...wrapped.map((cell) => cell.length)); line++) {
      const cells = widths.map((size, column) => {
        const cell = wrapped[column]![line] ?? ""
        return cell + " ".repeat(size - widthOf(cell))
      })
      output.push(`│ ${cells.join(" │ ")} │`)
    }

    if (index === 0) {
      output.push(border("├", "┼", "┤"))
    }
  }

  output.push(border("└", "┴", "┘"))

  return output
}

// Code: comments, strings, numbers and common keywords (TypeScript, Python, Rust, shell) in colour.
const KEYWORDS = "const|let|var|function|return|if|else|elif|for|while|in|of|import|export|from|class|new|async|await|yield|type|interface|extends|def|fn|pub|use|match|true|false|null|undefined|None|True|False|self|this"
const CODE = new RegExp(`(\\/\\/.*$|(?<!\\S)#.*$)|("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|\\b(\\d+(?:\\.\\d+)?)\\b|\\b(${KEYWORDS})\\b`, "g")

export const highlight = (line: string) =>
  line.replace(CODE, (_, comment, text, num, keyword) =>
    comment ? style.comment(comment) : text ? style.string(text) : num ? style.number(num) : style.keyword(keyword))

// One line outside a code block.
const block = (line: string) => {
  const heading = line.match(/^#{1,6}\s+(.*)/)
  if (heading) return style.bold(style.accent(inline(heading[1]!)))

  const bullet = line.match(/^(\s*)[-*+]\s+(.*)/)
  if (bullet) return `${bullet[1]}${style.accent("•")} ${inline(bullet[2]!)}`

  const numbered = line.match(/^(\s*)(\d+[.)])\s+(.*)/)
  if (numbered) return `${numbered[1]}${style.accent(numbered[2]!)} ${inline(numbered[3]!)}`

  const quote = line.match(/^>\s?(.*)/)
  if (quote) return `${style.dim("│")} ${style.italic(inline(quote[1]!))}`

  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return style.dim("─".repeat(40))
  return inline(line)
}

export const renderMarkdown = (text: string, width = 80): ReadonlyArray<string> => {
  const out: Array<string> = []
  let fence: string | undefined // the open code block's language ("" if none given)

  const lines = text.split("\n")
  const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim())

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const marker = line.match(/^\s*```(\S*)/)
    const header = cells(line)
    const separator = cells(lines[index + 1] ?? "")

    if (fence === undefined && !marker && line.includes("|") &&
        separator.length === header.length && separator.every((cell) => /^:?-{3,}:?$/.test(cell))) {
      const rows = [header]
      index++ // Skip the source separator; renderTable creates an aligned one.

      while (index + 1 < lines.length) {
        const next = lines[index + 1]!
        const row = cells(next)
        if (!next.includes("|") || /^\s*```/.test(next) || row.length !== header.length) break
        rows.push(row)
        index++
      }

      out.push(...renderTable(rows, Math.max(2, Math.floor(width))))
      continue
    }

    if (marker) {
      out.push(style.dim(fence === undefined ? `╭─ ${marker[1] || "code"}` : "╰─"))
      fence = fence === undefined ? marker[1]! : undefined
    } else out.push(fence === undefined ? block(line) : `${style.dim("│")} ${highlight(line)}`)
  }

  return out
}
