import { expect, test } from "bun:test"
import { renderMarkdown } from "../../src/ui/tui/markdown"
import { printLine } from "../../src/ui/tui/view"

test("Markdown tables are drawn as boxes, cells padded so the columns line up", () => {
  const input = [
    "| Tool | Purpose |",
    "| --- | --- |",
    "| read | Read files |",
    "| bash | Run commands |",
  ].join("\n")

  const lines = renderMarkdown(input).map((line) => Bun.stripANSI(line))

  expect(lines).toEqual([
    "┌──────┬──────────────┐",
    "│ Tool │ Purpose      │",
    "├──────┼──────────────┤",
    "│ read │ Read files   │",
    "│ bash │ Run commands │",
    "└──────┴──────────────┘",
  ])
})

test("wide reply tables wrap inside their columns at the actual viewport width", () => {
  const text = [
    "| Option | Current cost | Approach | Trade-off |",
    "| --- | --- | --- | --- |",
    "| **Retry test: simulated time** | 2.00 s | Advance a test clock through the retry delay instead of waiting two real seconds. | Keeps the production delay unchanged. |",
    "| Claude idle test | 6.17 s | Shorten the fake CLI waits. | Keep the subprocess integration test. |",
  ].join("\n")

  for (const width of [40, 79, 120]) {
    const lines = printLine({ kind: "reply", text }, width).filter(Boolean).map(Bun.stripANSI)
    expect(lines.every((line) => Bun.stringWidth(line) === width)).toBe(true)
    const body = lines.filter((line) => line.startsWith("│"))
    const columns = body[0]!.split("│").slice(1, -1).map((_, column) =>
      body.map((line) => line.split("│")[column + 1]!.trim()).join(" ").replace(/\s+/g, " "))
    expect(columns[2]!.replace(/\s/g, "")).toContain("Advanceatestclockthroughtheretrydelayinsteadofwaitingtworealseconds.")
    expect(columns[3]!.replace(/\s/g, "")).toContain("Keepstheproductiondelayunchanged.")
  }
})

test("narrow tables become labeled records without losing cell values", () => {
  const text = "| Name | Value | Note |\n| --- | --- | --- |\n| Retry | 2 s | Safe |\n| Idle | 6 s | Keep |"
  const lines = renderMarkdown(text, 18).map(Bun.stripANSI)
  expect(lines).toEqual(["Name: Retry", "Value: 2 s", "Note: Safe", "", "Name: Idle", "Value: 6 s", "Note: Keep"])
  expect(renderMarkdown("| Name | Value | Note |\n| --- | --- | --- |", 18).map(Bun.stripANSI)).toEqual(["Name", "Value", "Note"])
})

test("wrapped table cells preserve wide characters, long words, styles and clickable links", () => {
  const text = "| Item | Details |\n| --- | --- |\n| **界面界面** | [abcdefghijklmnopqrst](https://example.com) |"
  const rendered = renderMarkdown(text, 25)
  const lines = rendered.map(Bun.stripANSI)
  expect(lines.every((line) => Bun.stringWidth(line) === 25)).toBe(true)
  const body = lines.filter((line) => line.startsWith("│")).slice(1)
  expect(body.map((line) => line.split("│")[1]!.trim()).join("")).toBe("界面界面")
  expect(body.map((line) => line.split("│")[2]!.trim()).join("")).toBe("abcdefghijklmnopqrst")
  const linked = rendered.filter((line) => line.includes("https://example.com"))
  expect(linked.length).toBeGreaterThan(1)
  expect(linked.every((line) => line.includes("\x1b]8;;\x1b\\"))).toBe(true)
  expect(rendered.some((line) => line.includes("\x1b[1m"))).toBe(true)
})
