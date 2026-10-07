import { DEFAULT_THEME, themes, type ThemeName } from "./theme"

let palette = themes[DEFAULT_THEME] as (typeof themes)[ThemeName]
export const setTheme = (name: ThemeName) => { palette = themes[name] }
const themed = (role: keyof typeof palette) => (text: string) => sgr(`38;5;${palette[role]}`, "39")(text)

// The TUI's colours, in one place. 256-colour codes (38;5;N), which every modern terminal shows.
const sgr = (open: string, close = "0") => (text: string) => `\x1b[${open}m${text}\x1b[${close}m`

export const style = {
  bold: sgr("1", "22"),
  italic: sgr("3", "23"),
  dim: sgr("2", "22"),
  underline: sgr("4", "24"),
  accent: themed("accent"),   // empty-vessel's colour: the prompt, the box, headings
  user: sgr("38;5;252", "39"),     // what you typed
  step: themed("step"),     // System One's steps
  tool: sgr("38;5;114", "39"),     // commands System Two ran
  error: sgr("38;5;203", "39"),
  code: themed("code"),     // `inline code`
  link: sgr("38;5;75", "39"),
  keyword: sgr("38;5;176", "39"),  // in code blocks
  string: sgr("38;5;150", "39"),
  number: themed("number"),
  comment: sgr("38;5;244", "39"),
}

// A clickable link (OSC 8): terminals that support it open `url` on click; others just show the text.
export const hyperlink = (text: string, url: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`

// Visible width (ignores colour codes and links; wide characters count 2).
export const widthOf = (text: string) => Bun.stringWidth(Bun.stripANSI(text))
