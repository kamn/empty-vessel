import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { ConfigSchema } from "../../src/base/config"
import { responseStyle } from "../../src/system-two/style"

// The i-have-adhd skill (https://github.com/ayghri/i-have-adhd, Ayoub Ghriss, MIT) is System Two's style by default:
// credited in the prompt, its license kept beside the copy, its front matter (how other tools invoke it) left out.
test("System Two's default style is the i-have-adhd skill, credited; none turns it off", () => {
  expect(Schema.decodeUnknownSync(ConfigSchema)({}).systemTwo.style).toBe("i-have-adhd")

  const style = responseStyle("i-have-adhd")
  expect(style).toStartWith(`<response_style source="i-have-adhd: https://github.com/ayghri/i-have-adhd (Ayoub Ghriss, MIT License)">`)
  expect(style).toContain("### 1. Lead with the next action")
  expect(style).not.toContain("disable-model-invocation") // the front matter
  expect(responseStyle("none")).toBe("")

  const license = readFileSync(join(import.meta.dir, "../../src/system-two/styles/i-have-adhd.LICENSE"), "utf8")
  expect(license).toContain("Copyright (c) 2026 Ayoub Ghriss")
})
