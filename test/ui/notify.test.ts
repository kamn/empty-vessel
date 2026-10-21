import { expect, test } from "bun:test"
import { turnNotice } from "../../src/ui/tui/notify"

test("turnNotice: nothing for a quick turn; after 30 s an OSC 9 notification with the time and the reply's first line, no control characters", () => {
  expect(turnNotice(29_999, "done")).toBe("")
  expect(turnNotice(45_000, "\n\nFixed the \x1b[1mlogin\x1b[0m bug\nmore")).toBe("\x1b]9;empty-vessel finished (45s): Fixed the login bug\x07")
  expect(turnNotice(125_000, "")).toBe("\x1b]9;empty-vessel finished (2m 5s)\x07")
})
