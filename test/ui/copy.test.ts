import { expect, test } from "bun:test"
import { copyText, osc52 } from "../../src/ui/tui/copy"

test("copyText: outside macOS the terminal copies (OSC 52, base64 of the UTF-8 text)", () => {
  const written: string[] = []
  copyText("héllo\nworld", "linux", (s) => { written.push(s) })
  expect(written).toEqual([osc52("héllo\nworld")])
  expect(osc52("hi")).toBe("\x1b]52;c;aGk=\x07")
})
