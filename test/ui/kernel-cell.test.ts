import { expect, test } from "bun:test"
import { init, Message, update, type Line } from "../../src/ui/tui/app"
import { cellParts } from "../../src/ui/tui/cell"
import { printRows } from "../../src/ui/tui/view"
import { makeScreen } from "../../src/ui/tui/runtime"

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "")
const source = 'import { Effect } from "kernel"\n\nexport default Effect.gen(function* () {\n  const value = 1\n\n  return { value }\n})'
const output = 'cell 1: ok\n$1 (object) = {"name":"empty-vessel","runtime":"Bun","scripts":["start","build","kernel:view"]}'
const cell: Line = { kind: "system-two", text: "  system two ran: kernel: inspect scripts", body: `${source}\n── result ──\n${output}` }
const rendered = (line: Line, width = 80) => printRows(line, width).map((row) => plain(row.text)).join("\n")

test("kernel body separates code, pretty-prints its envelope and preserves logs", () => {
  expect(cellParts(cell.body!)?.source).toBe(source)
  expect(cellParts(cell.body!)?.result).toContain('\n  "name": "empty-vessel",')
  expect(cellParts('code\n── result ──\n{"ok":true}')?.result).toBe('{\n  "ok": true\n}')
  expect(cellParts('code\n── result ──\n$2 (string) = "a\\nb"')?.result).toBe('$2 (string) = a\nb')
  expect(cellParts('code\n── result ──\n$3 (object) = {"ok":true}\nlogs:\nhello')?.result).toEndWith('\nlogs:\nhello')
  expect(cellParts('no marker')).toBeUndefined()
})

test("plain errors and truncated JSON stay unchanged", () => {
  for (const result of ['cell 2: failed\nboom', '$3 (object) = {"big":\n[… shortened]', '']) {
    expect(cellParts(`code\n── result ──\n${result}`)?.result).toBe(result)
  }
})

test("notebook folds both previews and highlights source without hiding the result label", () => {
  const rows = printRows(cell)
  const shown = rendered(cell)
  expect(shown).toContain("╭")
  expect(shown).toContain("TypeScript")
  expect(shown).toContain("RESULT")
  expect(shown.match(/click to expand/g)?.length).toBe(2)
  expect(shown).not.toContain("kernel:view")
  expect(rows.find((row) => row.text.includes("import"))?.text).toContain("\x1b[38;5;176m")
})

test("source and result expand independently; Ctrl+O opens both; header collapses both", () => {
  const start = { ...init("status"), printed: [cell] }
  const sourceOpen = update(start, Message.ClickedLine({ index: 0, section: "source" })).model
  expect(rendered(sourceOpen.printed[0]!)).toContain("return")
  expect(rendered(sourceOpen.printed[0]!)).not.toContain("kernel:view")
  const resultOpen = update(start, Message.ClickedLine({ index: 0, section: "result" })).model
  expect(rendered(resultOpen.printed[0]!)).toContain("kernel:view")
  expect(resultOpen.printed[0]!.sourceOpen).toBeUndefined()
  const resultClosed = update(resultOpen, Message.ClickedLine({ index: 0, section: "result" })).model
  expect(rendered(resultClosed.printed[0]!)).not.toContain("kernel:view")
  const both = update(resultOpen, Message.PressedKey({ key: "\x0f" })).model
  expect(both.printed[0]!.sourceOpen).toBe(true)
  const closed = update(both, Message.ClickedLine({ index: 0 })).model
  expect(closed.printed[0]!.resultOpen).toBe(false)
  expect(closed.printed[0]!.sourceOpen).toBe(false)
})

test("cell boxes fit narrow screens, nested indentation, Unicode and long output", () => {
  const long = { ...cell, text: `          ${cell.text}`, body: `const x = "你好😀${"x".repeat(120)}"\n── result ──\n${"z".repeat(300)}` }
  for (const width of [1, 4, 12, 30, 80]) {
    for (const row of printRows(long, width)) expect(Bun.stringWidth(row.text)).toBeLessThanOrEqual(width)
    expect(printRows(long, width).filter((row) => row.section === "result").length).toBeGreaterThan(0)
  }
})

test("text cells preserve prose and malformed kernel bodies keep the legacy view", () => {
  const text = { ...cell, text: "system two ran: kernel: text draft (1 lines)", body: "return true\n── result ──\ndefined draft" }
  expect(rendered(text)).toContain("TEXT")
  expect(printRows(text).find((row) => row.text.includes("return true"))?.text).not.toContain("\x1b[38;5;176m")
  expect(rendered({ ...cell, body: "old event body" })).not.toContain("╭")
})

test("screen routes section clicks correctly after resize and scrolling", () => {
  const out = process.stdout as unknown as { write: unknown; rows: number; columns: number }
  const saved = { write: out.write, rows: out.rows, columns: out.columns }
  let frame = ""
  out.write = (text: string) => { frame = plain(text); return true }
  try {
    const screen = makeScreen()

    for (const [columns, scrollBack] of [[81, 0], [41, 20]]) {
      out.rows = 40; out.columns = columns!
      const after = scrollBack ? Array.from({ length: 20 }, () => ({ kind: "info", text: "later output" })) : []
      screen.draw({ ...init("status"), printed: [cell, ...after], scrollBack: scrollBack! })
      const lines = frame.replace(/^\x1b\[\?2026h/, "").split("\r\n")
      for (const [label, section] of [["TypeScript", "source"], ["RESULT", "result"]] as const) {
        const row = lines.findIndex((line) => line.includes(label))
        expect(row).toBeGreaterThanOrEqual(0)
        screen.select("press", [row, 4])
        expect(screen.select("release", [row, 4])).toEqual({ clicked: 0, section })
      }
    }
  } finally {
    out.write = saved.write; out.rows = saved.rows; out.columns = saved.columns
  }
})

test("oversized or truncated result lines use one clipped preview and keep full output on expansion", () => {
  for (const output of [
    `cell 2: ok\n$2 (string) = "${'import { read } from \\"kernel\\";\\n'.repeat(30)}\n[… shortened]`,
    JSON.stringify({ text: "abcdef".repeat(100) }),
    "plain output ".repeat(80),
  ]) {
    const long = { ...cell, body: `export default 1\n── result ──\n${output}` }
    for (const width of [50, 80, 200, 2000]) {
      const rows = printRows(long, width).filter((row) => row.section === "result")
      expect(rows).toHaveLength(4) // divider, heading, one clipped value, expand hint
      expect(rows.map((row) => plain(row.text)).join("\n")).toContain("long result · click to expand")
      for (const row of rows) expect(Bun.stringWidth(row.text)).toBeLessThanOrEqual(width)
    }
    const expanded = { ...long, resultOpen: true }
    const outputRows = printRows(expanded, 2000).filter((row) => row.section === "result").map((row) => plain(row.text))
    const expected = cellParts(long.body!)!.result.split("\n")
    for (const text of expected) expect(outputRows.some((row) => row.includes(text))).toBe(true)
    expect(rendered(expanded, 2000)).toContain("click to collapse")
  }
})

test("a merged kernel/code header does not repeat the export expression", () => {
  const code = 'export default read("src/ui/tui/cell.ts", 1, 25)'
  const short = { ...cell, text: `system two ran: kernel: ${code}`, body: `import { read } from "kernel"\n${code}\n── result ──\nOK` }
  const shown = rendered(short, 120)
  expect(shown).toContain("kernel · TypeScript")
  expect(shown.split(code)).toHaveLength(2)
  const header = printRows(short, 120).find((row) => row.text.includes("TypeScript"))!
  expect(header.section).toBe("source")
})

test("thinking gets a diamond note without repeating its first line", () => {
  const body = "Inspecting the file.\nChecking formatting.\nChecking click targets.\nChecking width.\nFinished reading."
  const thought = { kind: "system-two", text: "  thought: Inspecting the file.", body }
  const start = { ...init("status"), printed: [thought] }
  expect(rendered(thought)).toContain("◆ Inspecting the file.")
  expect(rendered(thought)).not.toMatch(/[╭╰│─]/)
  expect(rendered(thought).split("Inspecting the file.")).toHaveLength(2)
  expect(rendered(thought)).not.toContain("Finished reading.")
  const opened = update(start, Message.ClickedLine({ index: 0 })).model
  expect(rendered(opened.printed[0]!)).toContain("Finished reading.")
  const closed = update(opened, Message.ClickedLine({ index: 0 })).model
  expect(rendered(closed.printed[0]!)).not.toContain("Finished reading.")
  const keyboard = update(start, Message.PressedKey({ key: "\x0f" })).model
  expect(rendered(keyboard.printed[0]!)).toContain("Finished reading.")
})

test("long thinking without a body can expand, and public notes remain fully visible", () => {
  const thought = { kind: "system-two", text: `thought: ${"Inspecting the file. ".repeat(30)}END` }
  const state = { ...init("status"), printed: [thought] }
  expect(rendered(thought, 50)).not.toContain("END")
  const opened = update(state, Message.ClickedLine({ index: 0 })).model
  expect(rendered(opened.printed[0]!, 50)).toContain("END")
  const note = { kind: "note", text: "One\nTwo\nThree\nFour\nFive\nEND" }
  expect(rendered(note)).toContain("◆ One")
  expect(rendered(note)).not.toMatch(/[╭╰│─]/)
  expect(rendered(note)).toContain("END")
  expect(rendered(note)).not.toContain("click to expand")
  for (const line of [thought, note]) {
    for (const width of [1, 4, 12, 50, 80]) {
      for (const row of printRows(line, width)) expect(Bun.stringWidth(row.text)).toBeLessThanOrEqual(width)
    }
  }
})

test("the long-line threshold starts above 160 characters", () => {
  const output = (size: number) => rendered({ ...cell, body: `1\n── result ──\n${"x".repeat(size)}` }, 200)
  expect(output(160)).not.toContain("long result")
  expect(output(161)).toContain("long result · click to expand")
})
