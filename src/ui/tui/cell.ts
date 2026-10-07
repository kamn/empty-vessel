import { highlight } from "./markdown"
import { style, widthOf } from "./style"

export type CellSection = "source" | "result"
export type CellRow = { readonly text: string; readonly section?: CellSection }
export const CELL_PREVIEW = 4
export const LONG_RESULT_LINE = 160 // Oversized strings get one clipped row, not a wall of wrapped text.

// Format JSON values, including the kernel's `$N (type) = ...` envelope.
const formatResult = (output: string) => {
  const envelope = output.match(/^([\s\S]*?^\$\d+ \([^\n]*\) = )([\s\S]*)$/m)
  const prefix = envelope?.[1] ?? ""
  const payload = envelope?.[2] ?? output
  const logsAt = payload.indexOf("\nlogs:\n")
  const value = logsAt < 0 ? payload : payload.slice(0, logsAt)
  const logs = logsAt < 0 ? "" : payload.slice(logsAt)

  try {
    const parsed = JSON.parse(value)
    const formatted = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2)
    return prefix + formatted + logs
  } catch {
    return output // Errors, plain text and shortened JSON stay intact.
  }
}

// Kernel events carry source and output in one body; split them only for display.
export const cellParts = (body: string) => {
  const marker = "\n── result ──\n"
  const boundary = body.indexOf(marker)
  if (boundary < 0) return undefined

  const source = body.slice(0, boundary)
  const output = body.slice(boundary + marker.length)
  const result = formatResult(output)

  return { source, result }
}

// Wrap before painting: borders stay aligned, and output cannot inject terminal controls.
const cellWrap = (text: string, width: number): string[] => {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\t/g, "  ").replace(/[\x00-\x1f\x7f]/g, "")
  const rows: string[] = []
  let row = ""

  for (const char of clean) {
    if (widthOf(row + char) > width) {
      rows.push(row)
      row = ""
    }

    row += widthOf(char) > width ? "?" : char
  }

  return [...rows, row]
}

export const isKernelCell = (line: { kind: string; text: string; body?: string }) =>
  line.kind === "system-two" && /^\s*system two ran: kernel:/.test(line.text) && line.body !== undefined && cellParts(line.body) !== undefined

export const renderCell = (line: { text: string; body?: string; summary?: string; open?: boolean; sourceOpen?: boolean; resultOpen?: boolean }, width: number): CellRow[] => {
  const parts = cellParts(line.body ?? "")!

  if (width < 5) {
    return (["source", "result"] as const).flatMap((section) => {
      const content = parts[section].split("\n").flatMap((text) => cellWrap(text, Math.max(1, width)))
      const open = (section === "source" ? line.sourceOpen : line.resultOpen) ?? line.open ?? false
      return (open ? content : content.slice(0, CELL_PREVIEW)).map((text) => ({ text, section }))
    })
  }

  const pad = " ".repeat(Math.min(line.text.match(/^\s*/)![0].length, Math.max(0, width - 12)))
  const inner = Math.max(1, width - pad.length - 4)
  const rows: CellRow[] = []
  const edge = (left: string, right: string) => `${pad}${style.dim(left + "─".repeat(inner + 2) + right)}`
  const put = (text: string, section?: CellSection, paint = (s: string) => s) => {
    for (const piece of cellWrap(text, inner)) {
      rows.push({ text: `${pad}${style.dim("│")} ${paint(piece)}${" ".repeat(Math.max(0, inner - widthOf(piece)))} ${style.dim("│")}`, ...(section ? { section } : {}) })
    }
  }
  const textCell = /^\s*system two ran: kernel: text /.test(line.text)
  const title = line.text.trimStart().replace(/^system two ran: kernel: /, "")
  rows.push({ text: edge("╭", "╮") })

  for (const section of ["source", "result"] as const) {
    const open = (section === "source" ? line.sourceOpen : line.resultOpen) ?? line.open ?? false
    const lines = parts[section].split("\n")
    const content = lines.flatMap((text) => cellWrap(text, inner))
    const longLine = section === "result" ? lines.find((text) => widthOf(text) > LONG_RESULT_LINE) : undefined
    const shown = open ? content : longLine !== undefined
      ? [cellWrap(longLine, Math.max(1, Math.min(LONG_RESULT_LINE, inner - 1)))[0]! + (inner > 1 ? "…" : "")]
      : content.slice(0, CELL_PREVIEW)
    const name = section === "source" ? (textCell ? `kernel · TEXT · ${title.replace(/^text /, "")}` : "kernel · TypeScript") + (line.summary?.trim() ? ` · ${line.summary.replace(/\s+/g, " ").trim()}` : "") : "RESULT"
    if (section === "result") rows.push({ text: edge("├", "┤"), section })
    const heading = `${open ? "▾" : "▸"} ${name}`
    const clipped = !open && widthOf(heading) > inner
    put(clipped ? cellWrap(heading, Math.max(1, inner - 1))[0]! + (inner > 1 ? "…" : "") : heading, section, style.accent)

    for (const text of shown) {
      put(text, section, section === "source" && textCell ? (s) => s : highlight)
    }

    if (content.length > CELL_PREVIEW || longLine !== undefined) {
      const hint = longLine !== undefined ? "long result · click to expand" : `… ${content.length - shown.length} more lines · click to expand`
      put(open ? "click to collapse" : hint, section, style.dim)
    }
  }

  rows.push({ text: edge("╰", "╯") })
  return rows
}

export const isThinking = (line: { kind: string; text: string }) =>
  line.kind === "system-two" && /^\s*thought:/.test(line.text)

// Thinking already emitted by the backend and public notes share a light, unboxed style.
export const renderNotes = (line: { kind: string; text: string; body?: string; open?: boolean }, width: number): string[] => {
  const note = line.kind === "note"
  const text = note ? line.text.trimStart() : line.body ?? line.text.replace(/^\s*thought:\s?/, "")
  const pad = " ".repeat(Math.min(line.text.match(/^\s*/)![0].length, Math.max(0, width - 3)))
  const inner = Math.max(1, width - pad.length - 2)
  const content = text.split("\n").flatMap((row) => cellWrap(row, width < 3 ? Math.max(1, width) : inner))
  const shown = note || line.open ? content : content.slice(0, CELL_PREVIEW)
  if (width < 3) return shown

  const rows = shown.map((text, index) => `${pad}${index === 0 ? style.accent("◆ ") : "  "}${text}`)

  if (!note && content.length > CELL_PREVIEW) {
    const hint = line.open ? "click to collapse" : `… ${content.length - shown.length} more lines · click to expand`
    rows.push(...cellWrap(hint, inner).map((text) => `${pad}  ${style.dim(text)}`))
  }

  return ["", ...rows]
}
