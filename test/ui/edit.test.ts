import { expect, test } from "bun:test"
import { backspace, beforeCursor, deleteAfter, deleteToEnd, deleteWord, type Draft, end, home, insert, left, lineDown, lineUp, right, wordLeft, wordRight } from "../../src/ui/tui/edit"

// "|" marks the cursor, to write drafts and check them at a glance.
const d = (s: string): Draft => ({ input: s.replace("|", ""), after: Array.from(s).length - 1 - Array.from(s).indexOf("|") })
const show = (x: Draft | undefined) => (x ? `${beforeCursor(x)}|${Array.from(x.input).slice(Array.from(x.input).length - x.after).join("")}` : undefined)

test("moving and typing in the middle", () => {
  expect(show(insert(d("helo|"), "!"))).toBe("helo!|")
  expect(show(insert(left(d("helo|")), "l"))).toBe("hell|o")
  expect(show(right(d("ab|")))).toBe("ab|") // at the end already
  expect(show(left(d("|ab")))).toBe("|ab")
  expect(show(backspace(d("ab|cd")))).toBe("a|cd")
  expect(show(deleteAfter(d("ab|cd")))).toBe("ab|d")
  expect(show(insert(d("a|🙂b"), "x"))).toBe("ax|🙂b")
  expect(show(left(d("a🙂|b")))).toBe("a|🙂b") // an emoji is one character
})

test("words: jump, and Ctrl+W", () => {
  expect(show(wordLeft(d("fix the bug|")))).toBe("fix the |bug")
  expect(show(wordLeft(d("fix the |bug")))).toBe("fix |the bug")
  expect(show(wordRight(d("|fix the bug")))).toBe("fix| the bug")
  expect(show(deleteWord(d("fix the bug|")))).toBe("fix the |")
  expect(show(deleteWord(d("fix the |bug")))).toBe("fix |bug")
})

test("lines: Home / End, Ctrl+K, and Up / Down between lines (undefined at the edges: history then)", () => {
  const draft = d("first line\nsec|ond\nthird")
  expect(show(home(draft))).toBe("first line\n|second\nthird")
  expect(show(end(draft))).toBe("first line\nsecond|\nthird")
  expect(show(deleteToEnd(draft))).toBe("first line\nsec|\nthird")
  expect(show(deleteToEnd(d("a|\nb")))).toBe("a|b") // at a line's end: the line break
  expect(show(lineUp(draft))).toBe("fir|st line\nsecond\nthird")
  expect(show(lineDown(draft))).toBe("first line\nsecond\nthi|rd")
  expect(show(lineDown(d("a long line\nsho|rt\nx")))).toBe("a long line\nshort\nx|") // clamped to a shorter line
  expect(lineUp(d("fi|rst\nsecond"))).toBeUndefined()
  expect(lineDown(d("first\nsec|ond"))).toBeUndefined()
})

test("backspace takes a text label as a whole", () => {
  expect(show(backspace(d("explain [Text #1]|")))).toBe("explain |")
  expect(show(backspace(d("[Text #12]| next")))).toBe("| next")
  expect(show(backspace(d("[Text #1][Text #2]|")))).toBe("[Text #1]|")
  expect(show(backspace(d("[Text #1] |")))).toBe("[Text #1]|")
  expect(show(backspace(d("hello|")))).toBe("hell|")
})

test("backspace takes an image label as a whole", () => {
  expect(show(backspace(d("look at [Image #1]|")))).toBe("look at |")
  expect(show(backspace(d("look at [Image #1] |")))).toBe("look at [Image #1]|")
})
