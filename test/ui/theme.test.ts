import { afterEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigSchema } from "../../src/base/config"
import { logo } from "../../src/ui/logo"
import { renderMarkdown } from "../../src/ui/tui/markdown"
import { setTheme, style } from "../../src/ui/tui/style"
import { DEFAULT_THEME, themes, type ThemeName } from "../../src/ui/tui/theme"

afterEach(() => setTheme(DEFAULT_THEME))

test("theme config defaults to teal and rejects unknown names", () => {
  const decode = Schema.decodeUnknownSync(ConfigSchema)
  expect(DEFAULT_THEME).toBe("teal")
  expect(decode({}).theme).toBe("teal")
  expect(decode({ theme: "orange" }).theme).toBe("orange")
  expect(() => decode({ theme: "purple" })).toThrow()
})

test("every configured palette paints existing renderers and leaves errors red", () => {
  for (const name of Object.keys(themes) as ThemeName[]) {
    const config = Schema.decodeUnknownSync(ConfigSchema)({ theme: name })
    setTheme(config.theme)

    for (const role of ["accent", "step", "code", "number"] as const) {
      expect(style[role]("x")).toBe(`\x1b[38;5;${themes[name][role]}mx\x1b[39m`)
    }
    expect(renderMarkdown("# Heading")[0]).toContain(style.accent("Heading"))
    expect(style.error("x")).toBe("\x1b[38;5;203mx\x1b[39m")
    expect(logo(0, true, name)).toContain(`\x1b[38;5;${themes[name].accent}m`)
    expect(logo(0, false, name)).not.toContain("\x1b")
  }
})
