import { expect, test } from "bun:test"
import { renderMarkdown } from "../../src/ui/tui/markdown"

test("web and local-file links emit clickable OSC 8 links", () => {
  for (const url of ["https://example.com/page", "http://example.com", "file:///tmp/my%20file.ts"]) {
    const labeled = renderMarkdown(`[Open](${url})`).join("\n")
    const bare = renderMarkdown(url).join("\n")

    expect(labeled).toContain(`\x1b]8;;${url}\x1b\\Open\x1b]8;;\x1b\\`)
    expect(bare).toContain(`\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`)
  }
})

test("code and unsupported link schemes are not clickable", () => {
  expect(renderMarkdown("`file:///tmp/code.ts`").join("\n")).not.toContain("\x1b]8;")
  expect(renderMarkdown("[Run](javascript:alert)").join("\n")).not.toContain("\x1b]8;")
})
