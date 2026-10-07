import adhd from "./styles/i-have-adhd.md" with { type: "text" }

// How System Two shapes what it writes to the user, added to its briefing each session (src/loop/turn.ts); config
// systemTwo.style picks it, "none" for no style. In the briefing, not empty-vessel's own instructions, so a named agent's
// instructions (which come after it) can change it.
//
// i-have-adhd: the skill from https://github.com/ayghri/i-have-adhd (skills/i-have-adhd/SKILL.md, commit 839872f),
// by Ayoub Ghriss, MIT License (styles/i-have-adhd.LICENSE). The file is kept as published; its front matter (how a
// skill is invoked elsewhere) is left out of the prompt.
const STYLES = { "i-have-adhd": adhd } as const

const withoutFrontMatter = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n+/, "").trim()

export const responseStyle = (name: keyof typeof STYLES | "none") =>
  name === "none" ? "" : `<response_style source="${name}: https://github.com/ayghri/i-have-adhd (Ayoub Ghriss, MIT License)">\n${withoutFrontMatter(STYLES[name])}\n</response_style>`
