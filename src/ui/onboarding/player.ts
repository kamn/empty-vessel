import { Effect } from "effect"
import { style as S, widthOf } from "../tui/style"
import { type Scene, SCENES } from "./scenes"

// The onboarding's player: full screen, one scene at a time, animated. Enter (or →, or
// space) finishes a scene's animation, then moves on; ← goes back; s skips to setup; q (or Esc, Ctrl+C) leaves.
// Resolves with what the reader chose at the end: "setup" or "later".

const KEYS = "Enter next · ← back · s skip to setup · q later"

// A line cut to `width` columns (colour codes kept, wide characters count 2), with … if it was cut: the scenes are
// laid out for 60 columns and more, and a narrower terminal still gets whole screens.
export const fit = (line: string, width: number) => {
  if (widthOf(line) <= width) return line
  let out = "", used = 0

  for (const token of line.match(/\x1b\[[0-9;]*m|[^]/gu) ?? []) {
    if (token.startsWith("\x1b")) { out += token; continue }
    const size = widthOf(token)
    if (used + size > width - 1) break
    out += token; used += size
  }

  return `${out}\x1b[0m…`
}

// One screen: a header, the scene's title, its lines at `t` (the newest ones if they don't fit), and the keys.
export const screen = (scenes: ReadonlyArray<Scene>, index: number, t: number, columns: number, rows: number, scroll = 0) => {
  const scene = scenes[index]!
  const width = Math.max(40, Math.min(78, columns - 4))
  const margin = " ".repeat(Math.max(0, Math.floor((columns - width) / 2)))
  const last = index === scenes.length - 1

  const left = `empty-vessel · getting started${scene.illustrative ? " · example numbers" : ""}`, right = `${index + 1}/${scenes.length}`
  const header = S.dim(`${left}${" ".repeat(Math.max(1, width - left.length - right.length))}${right}`)
  const title = scene.title ? [S.accent(S.bold(scene.title)), ""] : []
  const keys = last && t >= scene.length ? `${S.accent("Enter")} set up now · ${S.accent("q")} later (empty-vessel setup)` : S.dim(`${scene.preserveHistory ? "↑↓ scroll · " : ""}${KEYS}`)

  // Rows: the header, a blank, the title and a blank, the body, a blank, the keys. A body that doesn't fit loses its
  // opening paragraph first (the lines before its first blank), then its oldest lines: never half a sentence.
  const room = Math.max(3, rows - 4 - title.length)
  const body = scene.draw(t, width)
  const intro = body.indexOf("")
  const trimmed = body.length > room && intro > 0 ? body.slice(intro + 1) : body
  const offset = Math.max(0, Math.min(Math.floor(scroll), body.length - room))
  const shown = scene.preserveHistory ? body.slice(offset, offset + room) : trimmed.length > room ? trimmed.slice(-room) : trimmed

  const lines = [header, "", ...title, ...shown]
  while (lines.length < rows - 2) lines.push("")
  return [...lines, "", keys].map((l) => (l ? margin + fit(l, width) : l)).slice(0, rows)
}

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "")

export const playOnboarding = (scenes: ReadonlyArray<Scene> = SCENES) =>
  Effect.callback<"setup" | "later">((resume) => {
    const color = !process.env.NO_COLOR
    let index = 0, started = performance.now(), shownFrame = "", finished = false, scroll = 0

    const draw = () => {
      const lines = screen(scenes, index, performance.now() - started, process.stdout.columns || 80, process.stdout.rows || 24, scroll)
      const frame = (color ? lines : lines.map(plain)).join("\r\n")
      if (frame === shownFrame) return
      shownFrame = frame
      process.stdout.write(`\x1b[?2026h\x1b[H\x1b[J${frame}\x1b[?2026l`)
    }
    const go = (to: number) => { index = Math.max(0, Math.min(scenes.length - 1, to)); scroll = 0; started = performance.now(); draw() }

    const finish = (choice: "setup" | "later") => {
      if (finished) return
      finished = true
      clearInterval(ticker)
      process.stdin.off("data", onKey)
      if (process.stdin.isTTY) process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write("\x1b[?25h\x1b[?1049l") // the cursor and the screen from before
      resume(Effect.succeed(choice))
    }

    const onKey = (key: string) => {
      const t = performance.now() - started, scene = scenes[index]!
      if (key === "q" || key === "Q" || key === "\x03" || key === "\x1b") return finish("later")
      if (key === "s" || key === "S") return finish("setup")
      if (key === "\x1b[D" || key === "\x7f") return go(index - 1)

      if (scene.preserveHistory && (key === "\x1b[A" || key === "\x1b[B")) {
        const width = Math.max(40, Math.min(78, (process.stdout.columns || 80) - 4)), room = Math.max(3, (process.stdout.rows || 24) - 4 - (scene.title ? 2 : 0))
        scroll = Math.max(0, Math.min(Math.max(0, scene.draw(t, width).length - room), scroll + (key === "\x1b[A" ? -1 : 1)))
        return draw()
      }

      if (key !== "\r" && key !== " " && key !== "\x1b[C") return

      if (t < scene.length) { started = performance.now() - scene.length; return draw() } // finish the animation first
      if (index === scenes.length - 1) return finish("setup")
      go(index + 1)
    }

    process.stdout.write("\x1b[?1049h\x1b[?25l") // a screen of its own, no cursor
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", onKey).resume()
    const ticker = setInterval(draw, 40)
    draw()

    return Effect.sync(() => finish("later"))
  })

// Whether the first load shows it: an interactive start (no --prompt) on a terminal, before empty-vessel is set up here
// (no config in this home) and before it was shown here.
export const firstLoad = (o: { readonly interactive: boolean; readonly prompt: boolean; readonly configured: boolean; readonly shown: boolean }) =>
  o.interactive && !o.prompt && !o.configured && !o.shown
