import { Effect, Queue } from "effect"
import { type Message as Msg, Message, type Model, update } from "./app"
import { conversationWindow, live, printRows } from "./view"
import type { CellRow, CellSection } from "./cell"

// Terminal input comes in chunks: one key, several typed fast, or a paste. Pastes are wrapped in bracketed-paste
// markers (turned on below) and stay one piece; anything else is split into keys (escape sequences, control keys, text).
// keysOf handles complete pieces; makeInputDecoder below keeps paste state between terminal chunks.
const PASTE = /\x1b\[200~([\s\S]*?)\x1b\[201~/
export const keysOf = (chunk: string): ReadonlyArray<string> => {
  const paste = chunk.match(PASTE)
  if (paste) return [paste[1]!.replace(/\r\n?/g, "\n")]
  return chunk.match(/\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Z]|\x1b[\s\S]?|[\x00-\x1f\x7f]|[^\x00-\x1f\x7f\x1b]+/g) ?? []
}

// Keep incomplete markers and paste contents until the terminal closes the paste.
export const makeInputDecoder = () => {
  const start = "\x1b[200~", end = "\x1b[201~"
  let pending = "", pasting = false

  return (chunk: string) => {
    pending += chunk
    const events: { key: string; paste: boolean }[] = []

    while (pending) {
      const marker = pasting ? end : start
      const at = pending.indexOf(marker)

      if (pasting && at < 0) break
      if (at >= 0) {
        const text = pending.slice(0, at)
        events.push(...(pasting ? [{ key: text.replace(/\r\n?/g, "\n"), paste: true }] : keysOf(text).map(key => ({ key, paste: false }))))
        pending = pending.slice(at + marker.length)
        pasting = !pasting
        continue
      }

      let held = Math.min(marker.length - 1, pending.length)
      while (held && !pending.endsWith(marker.slice(0, held))) held--
      events.push(...keysOf(pending.slice(0, pending.length - held)).map(key => ({ key, paste: false })))
      pending = pending.slice(pending.length - held)
      break
    }

    return events
  }
}

// Selecting text with the mouse: the terminal sends drags to empty-vessel (mouse reporting is on, for the wheel), so empty-vessel
// draws the highlight itself and copies the text, as Claude Code does. A selection is two screen cells, [row, column].
type Cell = readonly [number, number]
export type Selection = { readonly from: Cell; readonly to: Cell }

const TOKENS = /\x1b\][^\x07]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|[^]/gu
const plain = (text: string) => text.replace(new RegExp(TOKENS.source.replace("|[^]", ""), "gu"), "")

// Cut a drawn line (with colour codes) at a screen column; `codes`: the ones before the cut, to carry on after it.
const cut = (line: string, col: number) => {
  let columns = 0, at = 0, codes = ""

  for (const token of line.match(TOKENS) ?? []) {
    if (token.startsWith("\x1b")) codes += token
    else if (columns >= col) break
    else columns += Bun.stringWidth(token)
    at += token.length
  }

  return { left: line.slice(0, at), right: line.slice(at), codes }
}

// The selection in screen order, and which columns of row `i` it covers ([start, end), or undefined).
const ordered = ({ from, to }: Selection) => (from[0] < to[0] || (from[0] === to[0] && from[1] <= to[1]) ? [from, to] : [to, from])
const span = (sel: Selection, i: number): [number, number] | undefined => {
  const [a, b] = ordered(sel)
  if (i < a![0] || i > b![0]) return undefined
  return [i === a![0] ? a![1] : 0, i === b![0] ? b![1] + 1 : Infinity]
}

// A row drawn with its selected part in reverse video (the colours before and after it stay).
export const highlight = (line: string, i: number, sel: Selection) => {
  const cols = span(sel, i)
  if (!cols) return line
  const head = cut(line, cols[0]), mid = cut(head.right, cols[1] - cols[0])
  return `${head.left}\x1b[7m${plain(mid.left)}\x1b[0m${head.codes}${mid.codes}${mid.right}`
}

// The selected text: each row's part, without colour codes or the padding at its end.
export const selectedText = (lines: ReadonlyArray<string>, sel: Selection) =>
  lines.flatMap((line, i) => {
    const cols = span(sel, i)
    return cols ? [plain(cut(cut(line, cols[0]).right, cols[1] - cols[0]).left).trimEnd()] : []
  }).join("\n")

// Split a drawn line into rows of the screen's width (wide characters count 2); colour codes carry on to the next row.
const wrapRow = (line: string, width: number) => {
  const wrapped: string[] = []
  let row = "", columns = 0, codes = ""

  for (const token of line.match(TOKENS) ?? []) {
    if (token.startsWith("\x1b")) { codes += token; row += token; continue }
    const size = Bun.stringWidth(token)

    if (columns + size > width) {
      wrapped.push(row + "\x1b[0m"); row = codes; columns = 0
    }

    row += token; columns += size
  }

  return [...wrapped, row + "\x1b[0m"]
}

// Draw a conversation viewport above the input, inside the terminal’s alternate screen.
export const makeScreen = () => {
  let shown = ""
  let painted: ReadonlyArray<string> = []
  let geometry = ""
  let rowsOf = new WeakMap<object, ReadonlyArray<CellRow>>() // each printed line's rows, at `rowsWidth`
  let rowsWidth = 0
  let drawn: ReadonlyArray<string> = [] // the lines on screen now, for copying a selection
  let selection: Selection | undefined
  let ownerOf = (_row: number) => -1 // the printed line (its index) drawn on a screen row, or -1

  let sectionOf = (_row: number): CellSection | undefined => undefined

  const draw = (model: Model) => {
    const width = Math.max(1, (process.stdout.columns || 80) - 1)
    const area = live(model, width, process.stdout.rows || 24)
    // A printed line never changes, so its rows are worked out once (again only if the width changes): a redraw costs
    // the same however long the conversation is, not a re-render of every earlier reply.
    if (width !== rowsWidth) { rowsOf = new WeakMap(); rowsWidth = width }
    const rows: Array<string> = [], owners: Array<number> = [] // each row, and which printed line it's from

    const sections: Array<CellSection | undefined> = []

    for (const [i, printed] of model.printed.entries()) {
      const made = rowsOf.get(printed) ?? printRows(printed, width).flatMap((row) => wrapRow(row.text, width).map((text) => ({ ...row, text })))
      rowsOf.set(printed, made)

      for (const row of made) {
        rows.push(row.text); owners.push(i); sections.push(row.section)
      }
    }


    const height = Math.max(0, (process.stdout.rows || 24) - area.lines.length)
    const window = conversationWindow(rows, height, model.scrollBack)
    const blank = Math.max(0, height - window.rows.length), first = rows.length - window.offset - window.rows.length
    const above = [...Array(blank).fill(""), ...window.rows]
    ownerOf = (row) => (row >= blank && row < above.length ? owners[first + row - blank] ?? -1 : -1)
    sectionOf = (row) => (row >= blank && row < above.length ? sections[first + row - blank] : undefined)
    drawn = [...above, ...area.lines]
    const lines = selection ? drawn.map((line, i) => highlight(line, i, selection!)) : drawn
    const cursor = { row: above.length + area.cursor.row, col: area.cursor.col }
    const size = `${width},${process.stdout.rows || 24},${lines.length}`
    const frame = `${size}:${lines.join("\n")}@${cursor.row},${cursor.col}` // the cursor too: a typed space changes only where it is
    if (frame === shown) return window.offset

    const place = `\x1b[${cursor.row + 1};${cursor.col + 1}H`
    let content = ""

    if (size !== geometry) {
      content = "\x1b[H\x1b[J" + lines.join("\r\n")
    } else {

      for (const [row, line] of lines.entries()) {
        if (line !== painted[row]) content += `\x1b[${row + 1};1H${line}\x1b[K`
      }

    }

    // Synchronized output: supporting terminals show the completed redraw, not the clear in between.
    // A single stdout.write alone does not guarantee that the terminal paints it all at once.
    const output = [
      "\x1b[?2026h", // hold the visible frame
      content,
      place,
      "\x1b[?2026l", // display the completed frame, with its cursor in place
    ].join("")
    process.stdout.write(output)

    shown = frame
    painted = [...lines]
    geometry = size
    return window.offset
  }

  // Leaving restores the terminal screen that was visible before the TUI.
  const erase = () => process.stdout.write("\x1b[?1049l")
  // A left-button press starts a selection, a drag moves its end, the release copies it. A click (press and release
  // on one cell) clears it and names the printed line there, if any.
  const select = (kind: "press" | "drag" | "release", at: Cell): { copied?: string; clicked?: number; section?: CellSection } => {
    if (kind === "press") selection = { from: at, to: at }
    if (!selection) return {}
    if (kind !== "press") selection = { ...selection, to: at }
    if (kind !== "release") return {}

    const same = selection.from[0] === at[0] && selection.from[1] === at[1]
    const copied = same ? undefined : selectedText(drawn, selection)
    if (same) selection = undefined
    return same ? { clicked: ownerOf(at[0]), ...(sectionOf(at[0]) ? { section: sectionOf(at[0]) } : {}) } : { copied: copied! }
  }
  const unselect = () => { selection = undefined }

  return { draw, erase, select, unselect }
}

// Run the TUI until the user leaves (Ctrl+D, Ctrl+C on an empty line, /exit). Keys and a spinner tick come in as
// Messages; `update` gives the next Model and Commands (each forked: its result Message comes back in); the screen is
// redrawn after every Message. `connect` gets the dispatch function, so empty-vessel's loop can send events and questions.
// `attach`: finds image files named in a paste (the caller's: the TUI doesn't touch the filesystem), returning them with
// the text they're shown as labels in, numbered from `from`.
// `clipboard`: saves a picture on the clipboard to a file and gives its path (undefined: no picture there).
// `copy`: puts selected text on the clipboard.
// `checkpoint`: saves the visible state after real messages and on exit (not on spinner ticks).
type Io = {
  readonly attach?: (text: string, from: number) => { images: ReadonlyArray<{ label: string; path: string }>; text: string }
  readonly clipboard?: () => string | undefined
  readonly copy?: (text: string) => void
  readonly checkpoint?: (model: Model) => void
}
export const runTui = (start: Model, connect: (dispatch: (message: Msg) => void) => void, { attach = (text) => ({ images: [], text }), clipboard = () => undefined, copy = () => {}, checkpoint = () => {} }: Io = {}) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Msg>()
    const dispatch = (message: Msg) => { Queue.offerUnsafe(queue, message) }
    connect(dispatch)

    // A paste with image paths in it (dragging a file into the terminal pastes its path): each path that's a real image
    // is shown as [Image #N], numbered on from the labels already in the input, and the TUI keeps what each stands for.
    const decode = makeInputDecoder()
    const onData = (chunk: string) => {
      for (const { key, paste } of decode(chunk)) {
        // The left button (with no modifier: 0 press/release, 32 drag) selects text; other mouse reports go on.
        const mouse = !paste && key.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/)

        if (mouse && (mouse[1] === "0" || mouse[1] === "32")) {
          const kind = mouse[4] === "m" ? "release" : mouse[1] === "32" ? "drag" : "press"
          const { copied, clicked, section } = screen.select(kind, [Number(mouse[3]) - 1, Number(mouse[2]) - 1])
          if (copied) copy(copied)
          if (clicked !== undefined && clicked >= 0) dispatch(Message.ClickedLine({ index: clicked, ...(section ? { section } : {}) }))
          screen.draw(model)
          continue
        }

        if (!mouse) screen.unselect()
        // Ctrl+V: a picture on the clipboard (Cmd+V pastes only text), saved to a file and attached as if its path was pasted.
        const pasted = paste ? key : key === "\x16" ? clipboard() : undefined
        if (pasted === undefined) { dispatch(Message.PressedKey({ key })); continue }
        const { images, text } = attach(pasted, (model.input.match(/\[Image #\d+\]/g)?.length ?? 0) + 1)
        if (images.length) dispatch(Message.AttachedImages({ images }))
        dispatch(Message.PastedText({ text }))
      }
    }
    const ticker = setInterval(() => dispatch(Message.Ticked()), 100)
    process.stdin.setRawMode(true)
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", onData).resume()
    process.stdout.write("\x1b[?1049h\x1b[?2004h\x1b[?1002h\x1b[?1006h") // screen, paste, and SGR mouse reports (drags too) on

    const screen = makeScreen()
    const { draw, erase } = screen
    let model = start
    model = { ...model, scrollBack: draw(model) }

    const loop = Effect.gen(function* () {
      while (!model.exiting) {
        const message = yield* Queue.take(queue)
        const { model: next, commands = [] } = update(model, message)
        model = next
        for (const command of commands) yield* Effect.forkChild(command.effect.pipe(Effect.map(dispatch)))
        model = { ...model, scrollBack: draw(model) }
        if (message._tag !== "Ticked") checkpoint(model)
      }
    })

    yield* loop.pipe(Effect.ensuring(Effect.sync(() => {
      clearInterval(ticker)
      process.stdin.off("data", onData).pause()
      process.stdin.setRawMode(false)
      process.stdout.write("\x1b[?1002l\x1b[?1006l\x1b[?2004l") // restore normal mouse and paste handling
      erase()
      checkpoint(model)
    })))
  })