import { acceptCompletion, selectedCompletion, suggestions, type Completion } from "./completion"
import { Context, Effect, Schema } from "effect"
import * as Command from "foldkit/command"
import { defineMessageUnion } from "foldkit/message"
import type * as Update from "foldkit/update"
import { expandPastes, foldPaste } from "./paste"
import { isKernelCell, isThinking, type CellSection } from "./cell"
import { backspace, beforeCursor, deleteAfter, deleteToEnd, deleteWord, type Draft, end, home, insert, left, lineDown, lineUp, right, wordLeft, wordRight } from "./edit"

// The TUI as a Foldkit program (the Elm architecture): one Model, fact-named Messages, a pure `update`, and Commands
// for the side effects (running a turn, stopping it, answering a question). ./view.ts draws the Model, a small
// terminal runtime (./runtime.ts) feeds it keys and events, and src/tui.ts connects it to empty-vessel's loop.

export type UserAnswer = { readonly answer: string; readonly note?: string }

// What the TUI needs from empty-vessel. The Commands use it; tests never run them (Story resolves them by hand).
export class TurnRunner extends Context.Service<TurnRunner, {
  // `usage`: lines printed after the reply; `total`: the session's time and tokens so far, shown under the input box.
  readonly run: (input: string) => Effect.Effect<{ readonly reply: string; readonly usage: ReadonlyArray<string>; readonly total?: string }, string>
  // !command / !!command (src/answer.ts): run it; `share`: hand its output to empty-vessel too (one !), or only show it (!!).
  readonly shell: (command: string, share: boolean) => Effect.Effect<string, string>
  readonly stop: Effect.Effect<void>
  readonly answer: (reply: UserAnswer) => Effect.Effect<void>
  // A message for System Two while the turn runs (src/base/inbox.ts); SteerRead comes back when it has read it.
  readonly steer: (text: string) => Effect.Effect<void>
  // /flag <note>: mark this moment in the session for /refine (src/loop/refine.ts); never sent to System Two.
  readonly flag: (note: string, where: { readonly running: boolean; readonly activity: string }) => Effect.Effect<void>
}>()("empty-vessel/TurnRunner") {}

// A line in the scrollback: what it is (user, reply, usage, info, or an event kind from the loop), its text, and a body
// that's folded to a few lines (a script, a diff, an output, System Two's thinking) until it's `open` (a click, Ctrl+O).
const Line = Schema.Struct({ kind: Schema.String, text: Schema.String, body: Schema.optionalKey(Schema.String), summary: Schema.optionalKey(Schema.String), open: Schema.optionalKey(Schema.Boolean), sourceOpen: Schema.optionalKey(Schema.Boolean), resultOpen: Schema.optionalKey(Schema.Boolean) })
export type Line = typeof Line.Type
const Question = Schema.Struct({ question: Schema.String, options: Schema.Array(Schema.String) })

const Model = Schema.Struct({
  completions: Schema.Array(Schema.Struct({ command: Schema.String, description: Schema.String, skillName: Schema.optionalKey(Schema.String) })),
  completionSelected: Schema.Number,
  completionDismissed: Schema.Boolean,
  input: Schema.String,                 // what's being typed (may hold newlines)
  after: Schema.Number,                 // where the cursor is: how many characters of `input` are after it (0: the end)
  // Images pasted into the input (their paths), shown there as [Image #1]; sent as the paths when the message goes.
  attached: Schema.Array(Schema.Struct({ label: Schema.String, path: Schema.String })),
  pastes: Schema.Array(Schema.Struct({ label: Schema.String, text: Schema.String })),
  history: Schema.Array(Schema.String), // earlier inputs, for Up / Down
  historyAt: Schema.Number,             // where Up / Down is in `history` (its length = the new line)
  queued: Schema.Array(Schema.String),  // sent while a turn ran: each goes out when the one before it is done
  steering: Schema.Array(Schema.String), // sent to System Two while a turn runs (Enter), not yet read: queued if the turn ends first
  running: Schema.Boolean,
  stopping: Schema.Boolean,
  activity: Schema.String,              // what's happening right now (System One choosing, System Two thinking, a command)
  frame: Schema.Number,                 // spinner frame (a tick is 100 ms, so it's also the turn's time)
  scrollBack: Schema.Number,           // display rows back from the newest output; 0 follows the latest
  printed: Schema.Array(Line),          // everything printed so far (append-only: the terminal keeps it)
  status: Schema.String,                // systems and session, set once
  total: Schema.String,                 // the session's time and tokens so far
  selectedOption: Schema.Number,
  questionDraft: Schema.String,         // input saved while answering a question
  asking: Schema.NullOr(Question),      // a question from the loop (AskUser) waiting for an answer
  exiting: Schema.Boolean,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  UpdatedCompletions: { items: Schema.Array(Schema.Struct({ command: Schema.String, description: Schema.String, skillName: Schema.optionalKey(Schema.String) })) },
  PressedKey: { key: Schema.String },   // a key or escape sequence
  PastedText: { text: Schema.String }, // literal text, never a keyboard command
  AttachedImages: { images: Schema.Array(Schema.Struct({ label: Schema.String, path: Schema.String })) }, // a paste held images
  GotEvent: { kind: Schema.String, depth: Schema.Number, text: Schema.String, body: Schema.optionalKey(Schema.String), summary: Schema.optionalKey(Schema.String) },
  AskedUser: { question: Schema.String, options: Schema.Array(Schema.String) },
  Ticked: {},
  CompletedTurn: { reply: Schema.String, usage: Schema.Array(Schema.String), total: Schema.optionalKey(Schema.String) },
  ClickedLine: { index: Schema.Number, section: Schema.optionalKey(Schema.Literals(["source", "result"])) }, // a click on a printed line (its place in `printed`)
  FailedTurn: { error: Schema.String },
  CompletedShell: { command: Schema.String, share: Schema.Boolean, output: Schema.String },
  CompletedStop: {},
  CompletedAnswer: {},
  CompletedSteer: {},
  CompletedFlag: {},
  SteerRead: { text: Schema.String }, // System Two got a message sent mid-run
})
export type Message = typeof Message.Type

// COMMANDS: a turn (its reply, or why it failed), stopping it (Ctrl+C), answering the loop's question.
const RunTurn = Command.define("RunTurn", {
  args: { input: Schema.String },
  messages: [Message.CompletedTurn, Message.FailedTurn],
  execute: ({ input }) =>
    Effect.gen(function* () {
      const { reply, usage, total } = yield* (yield* TurnRunner).run(input)
      return Message.CompletedTurn({ reply, usage: [...usage], ...(total ? { total } : {}) })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedTurn({ error })))),
})

// A command you typed (!command or !!command): its output, for the scrollback.
const RunShell = Command.define("RunShell", {
  args: { command: Schema.String, share: Schema.Boolean },
  messages: [Message.CompletedShell, Message.FailedTurn],
  execute: ({ command, share }) =>
    Effect.gen(function* () {
      const output = yield* (yield* TurnRunner).shell(command, share)
      return Message.CompletedShell({ command, share, output })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedTurn({ error })))),
})

const StopTurn = Command.define("StopTurn", {
  messages: [Message.CompletedStop],
  execute: Effect.gen(function* () {
    yield* (yield* TurnRunner).stop
    return Message.CompletedStop()
  }),
})

const Answer = Command.define("Answer", {
  args: { answer: Schema.String, note: Schema.optionalKey(Schema.String) },
  messages: [Message.CompletedAnswer],
  execute: (reply) =>
    Effect.gen(function* () {
      yield* (yield* TurnRunner).answer(reply)
      return Message.CompletedAnswer()
    }),
})

const Steer = Command.define("Steer", {
  args: { text: Schema.String },
  messages: [Message.CompletedSteer],
  execute: ({ text }) =>
    Effect.gen(function* () {
      yield* (yield* TurnRunner).steer(text)
      return Message.CompletedSteer()
    }),
})

const Flag = Command.define("Flag", {
  args: { note: Schema.String, running: Schema.Boolean, activity: Schema.String },
  messages: [Message.CompletedFlag],
  execute: ({ note, running, activity }) =>
    Effect.gen(function* () {
      yield* (yield* TurnRunner).flag(note, { running, activity })
      return Message.CompletedFlag()
    }),
})

export const Commands = { RunTurn, RunShell, StopTurn, Answer, Steer, Flag }

// INIT
// `banner`: shown first, at the top of the conversation (the logo, as the screen takes over).
// Also accept the original (status, banner, completions?) call used by the terminal bridge.
export const init = (status: string, historyOrBanner: ReadonlyArray<string> | string = [], bannerOrCompletions?: string | ReadonlyArray<Completion>, completions: ReadonlyArray<Completion> = []): Model => {
  const history = typeof historyOrBanner === "string" ? [] : [...historyOrBanner]
  const banner = typeof historyOrBanner === "string" ? historyOrBanner : typeof bannerOrCompletions === "string" ? bannerOrCompletions : undefined
  const items = typeof bannerOrCompletions === "object" ? bannerOrCompletions : completions
  return {
    completions: [...items], completionSelected: 0, completionDismissed: false,
    input: "", after: 0, history, historyAt: history.length, queued: [], steering: [], running: false, stopping: false, activity: "", frame: 0,
    attached: [], pastes: [], scrollBack: 0, printed: banner ? [{ kind: "banner", text: banner }] : [], status, total: "", asking: null, selectedOption: 0, questionDraft: "", exiting: false,
  }
}

// UPDATE
type Return = Update.Return<Model, Message, TurnRunner>

export const PREVIEW = 4 // body lines shown before folding
const KEY = { enter: "\r", ctrlC: "\x03", ctrlD: "\x04", ctrlO: "\x0f", ctrlU: "\x15", up: "\x1b[A", down: "\x1b[B" } as const

// Print lines into the scrollback.
const print = (model: Model, ...lines: ReadonlyArray<Line>): Model => ({ ...model, printed: [...model.printed, ...lines] })

// `shown`: the message as printed (with [Image #1] labels); `text`: as sent (with the images' paths).
// A message starting with ! is a shell command you run (!! only for you), not a turn (src/answer.ts, userCommand).
const shellOf = (text: string) => {
  const m = text.match(/^(!!?)\s*([\s\S]*\S)/)
  return m ? { command: m[2]!, share: m[1] === "!" } : undefined
}
const start = (model: Model, text: string, shown = text): Return => {
  const history = [...model.history, text]
  const started = print(model, { kind: "user", text: shown })
  const shell = shellOf(text)
  const running = { ...started, input: "", after: 0, attached: [], pastes: [], history, historyAt: history.length, running: true, activity: shell ? `running ${shell.command}` : "", frame: 0 }
  return { model: running, commands: [shell ? RunShell(shell) : RunTurn({ input: text })] }
}

// A message's image labels back to the paths they stand for (spaces escaped, as a terminal pastes them), for the loop.
export const withPaths = (text: string, attached: ReadonlyArray<{ label: string; path: string }>) =>
  attached.reduce((t, a) => t.replaceAll(a.label, a.path.replace(/ /g, "\\ ")), text)

// Enter: answer the loop's question, queue the message while a turn runs, or start a turn.
const submit = (model: Model, later = false): Return => {
  const text = model.input.trim()

  if (model.asking) {
    const option = model.asking.options[model.selectedOption]
    const expanded = expandPastes(text, model.pastes)
    const reply: UserAnswer = option === undefined ? { answer: expanded } : { answer: option, ...(expanded ? { note: expanded } : {}) }
    if (!reply.answer) return { model }

    const shown = reply.note ? `${reply.answer}\nNote: ${reply.note}` : reply.answer
    const asked = print(model, { kind: "info", text: model.asking.question }, { kind: "user", text: shown })

    return { model: { ...asked, input: model.questionDraft, after: 0, questionDraft: "", asking: null }, commands: [Answer(reply)] }
  }

  if (!text) return { model }

  // /flag <note>: marks this moment for /refine, running or not; never interrupts, never goes to System Two.
  const flag = text.match(/^\/flag(?=\s|$)\s*([\s\S]*)$/)
  if (flag) {
    const flagged = print({ ...model, input: "", after: 0 }, { kind: "user", text }, { kind: "info", text: "  flagged" })
    return { model: flagged, commands: [Flag({ note: flag[1]!.trim(), running: model.running, activity: model.activity })] }
  }

  // While a turn runs, a message goes to System Two mid-run (steering): it reads it at its next step. Tab queues one for
  // after the turn instead (later).
  const sent = withPaths(expandPastes(text, model.pastes), model.attached)
  const cleared = { ...model, input: "", after: 0, attached: [], pastes: [] }
  if (model.running && later) return { model: { ...cleared, queued: [...model.queued, sent] } }
  if (model.running) return { model: { ...print(cleared, { kind: "user", text }, { kind: "info", text: "  for System Two, at its next step" }), steering: [...model.steering, sent] }, commands: [Steer({ text: sent })] }
  if (text === "/exit") return { model: { ...model, exiting: true } }
  return start(model, sent, text)
}

// A turn ended: its events are already in the scrollback; append what it said. The next queued message goes out, unless the
// turn was stopped or failed: then the queue comes back into the input box, to send or change.
const ended = (model: Model, ...lines: ReadonlyArray<Line>): Return => {
  model = model.asking ? { ...model, input: model.questionDraft, after: 0, questionDraft: "" } : model
  // Messages sent mid-run that System Two didn't get to (it finished first) go out first, as the next turn.
  const unread = model.steering.map((text): Line => ({ kind: "info", text: `  System Two finished first: "${text.slice(0, 60)}" goes as your next message` }))
  model = { ...model, queued: [...model.steering, ...model.queued], steering: [] }
  const done = { ...print(model, ...lines, ...unread), running: false, stopping: false, activity: "", asking: null }
  const [next, ...rest] = model.queued
  if (next !== undefined && !model.stopping && (lines[0]?.kind === "reply" || lines[0]?.kind === "shell")) return start({ ...done, queued: rest }, next)
  return { model: { ...done, queued: [], after: 0, input: [...model.queued, model.input].filter(Boolean).join("\n") } }
}

// Up / Down: walk through earlier inputs; past the newest is an empty line again.
const recall = (model: Model, by: number): Model => {
  const historyAt = Math.max(0, Math.min(model.history.length, model.historyAt + by))
  return { ...model, historyAt, input: model.history[historyAt] ?? "", after: 0 }
}

// Keys that edit the input or move its cursor. Terminals send some keys differently, so a few have several codes.
const EDITS: Record<string, (d: Draft) => Draft> = {
  "\x7f": backspace, "\b": backspace, "\x1b[3~": deleteAfter,
  "\x1b[D": left, "\x1b[C": right, "\x02": left, "\x06": right,
  "\x1bb": wordLeft, "\x1bf": wordRight, "\x1b[1;3D": wordLeft, "\x1b[1;3C": wordRight, "\x1b[1;5D": wordLeft, "\x1b[1;5C": wordRight,
  "\x01": home, "\x05": end, "\x1b[H": home, "\x1b[F": end, "\x1bOH": home, "\x1bOF": end, "\x1b[1~": home, "\x1b[4~": end,
  "\x17": deleteWord, "\x1b\x7f": deleteWord, "\x0b": deleteToEnd,
  "\x1b\r": (d) => insert(d, "\n"), // Alt+Enter: a line break
}

// Kernel sections wrap to the terminal width, so even one source line may need expansion.
// Other bodies fold when their raw line count exceeds the preview.
export const foldable = (line: Line | undefined) => line !== undefined && (isKernelCell(line) || isThinking(line) || (line.body !== undefined && line.body.split("\n").length > PREVIEW))
const toggle = (model: Model, index: number, section?: CellSection): Model => {
  const line = model.printed[index]
  if (!line || !foldable(line)) return model

  if (isKernelCell(line)) {
    const sourceOpen = line.sourceOpen ?? line.open ?? false
    const resultOpen = line.resultOpen ?? line.open ?? false
    const both = !(sourceOpen && resultOpen)
    const changed = section === "source" ? { sourceOpen: !sourceOpen }
      : section === "result" ? { resultOpen: !resultOpen } : { sourceOpen: both, resultOpen: both, open: both }

    return { ...model, printed: model.printed.map((l, i) => i === index ? { ...l, ...changed } : l) }
  }

  return { ...model, printed: model.printed.map((l, i) => (i === index ? { ...l, open: !l.open } : l)) }
}

// Ctrl+O: open the newest folded line.
const unfold = (model: Model): Model => toggle(model, model.printed.findLastIndex((l) => foldable(l) && (isKernelCell(l) ? !((l.sourceOpen ?? l.open) && (l.resultOpen ?? l.open)) : !l.open)))

const pressed = (model: Model, key: string): Return => {
  // SGR mouse reports: 64/65 are wheel up/down; ignore clicks and releases.
  const mouse = key.match(/^\x1b\[<(\d+);\d+;\d+([Mm])$/)

  if (mouse) {
    const button = Number(mouse[1]) & ~28 // ignore Shift, Alt, and Ctrl modifiers
    if (mouse[2] !== "M" || (button !== 64 && button !== 65)) return { model }
    const scrollBack = Math.max(0, model.scrollBack + (button === 64 ? 3 : -3))

    return { model: { ...model, scrollBack } }
  }

  // Move through output without changing the draft or recalling earlier inputs.
  // The screen renderer will clamp this offset to the available display rows.
  if (key === "\x1b[5~" || key === "\x1b[6~") {
    const by = key === "\x1b[5~" ? 10 : -10
    const scrollBack = Math.max(0, model.scrollBack + by)

    return { model: { ...model, scrollBack } }
  }

  // Esc stops a running turn (or command), as Ctrl+C does; with nothing running it does nothing (Ctrl+C clears or leaves).
  if (key === "\x1b" && model.running) return model.stopping ? { model } : { model: { ...model, stopping: true, activity: "stopping…" }, commands: [StopTurn()] }

  if (key === KEY.ctrlC) {
    if (model.running) return model.stopping ? { model } : { model: { ...model, stopping: true, activity: "stopping…" }, commands: [StopTurn()] }
    return { model: model.input ? { ...model, input: "", after: 0 } : { ...model, exiting: true } }
  }

  const items = suggestions(model)
  const selected = selectedCompletion(model, items)
  if (selected) {
    if (key === "\x1b") return { model: { ...model, completionDismissed: true } }
    if (key === KEY.up || key === KEY.down) return { model: { ...model, completionSelected: Math.max(0, Math.min(items.length - 1, model.completionSelected + (key === KEY.up ? -1 : 1))) } }
    if (key === "\t" || (key === KEY.enter && acceptCompletion(model, selected).input !== model.input)) {
      return { model: { ...model, ...acceptCompletion(model, selected), completionDismissed: true, completionSelected: 0 } }
    }
  }

  if (key === KEY.ctrlD) return { model: !model.running && !model.input ? { ...model, exiting: true } : model }
  // Enter sends, but after a \ it's a line break (as Alt+Enter is), for a message of several lines.
  if (key === KEY.enter && beforeCursor(model).endsWith("\\")) return { model: { ...model, ...insert(backspace(model), "\n") } }
  if (key === KEY.enter) return submit(model)
  if (key === "\t" && model.running && model.input.trim()) return submit(model, true) // Tab: for after this turn, not now
  if (key === KEY.ctrlO) return { model: unfold(model) }
  if (key === KEY.ctrlU) return { model: { ...model, input: "", after: 0 } }
  const edit = EDITS[key]
  if (edit) return { model: { ...model, ...edit(model) } }
  if (model.asking && (key === KEY.up || key === KEY.down)) {
    const last = model.asking.options.length // one extra row for a custom answer
    const selectedOption = Math.max(0, Math.min(last, model.selectedOption + (key === KEY.up ? -1 : 1)))

    return { model: { ...model, selectedOption } }
  }

  // In a draft of several lines, Up / Down move between them; from the first (or last) line, they recall earlier inputs.
  if (key === KEY.up) return { model: { ...model, ...(lineUp(model) ?? recall(model, -1)) } }
  if (key === KEY.down) return { model: { ...model, ...(lineDown(model) ?? recall(model, 1)) } }
  if (key.startsWith("\x1b")) return { model } // other keys (function keys): not used

  // Typing, or a paste, at the cursor: its line breaks stay (as \n), other control characters go.
  const text = key.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
  return { model: { ...model, ...insert(model, text) } }
}

// Activity updates only the spinner. Every other event joins the log immediately, in arrival order.
const got = (model: Model, { kind, depth, text, body, summary }: { kind: string; depth: number; text: string; body?: string; summary?: string }): Model => {
  if (kind === "activity") return model.running && !model.stopping ? { ...model, activity: text } : model
  const line: Line = { kind, text: `${"  ".repeat(depth)}${text}`, ...(body !== undefined ? { body } : {}), ...(summary ? { summary } : {}) }
  return print(model, line)
}

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    UpdatedCompletions: ({ items }) => ({ model: { ...model, completions: items, completionSelected: 0 } }),
    PressedKey: ({ key }) => {
      const next = pressed(model, key)
      // Acceptance stays dismissed; all other draft/cursor edits reopen and reset the menu.
      const accepting = suggestions(model).length > 0 && (key === "\t" || key === KEY.enter)
      return !accepting && (next.model.input !== model.input || next.model.after !== model.after)
        ? { ...next, model: { ...next.model, completionDismissed: false, completionSelected: 0 } } : next
    },
    PastedText: ({ text }) => {
      const clean = text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      const { shown, pastes } = foldPaste(clean, model.pastes)

      return { model: { ...model, ...insert(model, shown), pastes, completionDismissed: false, completionSelected: 0 } }
    },
    AttachedImages: ({ images }) => ({ model: { ...model, attached: [...model.attached, ...images] } }),
    GotEvent: (event) => ({ model: got(model, event) }),
    AskedUser: ({ question, options }) => ({ model: { ...model, asking: { question, options }, selectedOption: 0, questionDraft: model.asking ? model.questionDraft : model.input, input: "", after: 0 } }),
    Ticked: () => ({ model: model.running ? { ...model, frame: model.frame + 1 } : model }),
    CompletedTurn: ({ reply, usage, total }) =>
      ended({ ...model, total: total ?? model.total }, { kind: "reply", text: reply }, ...usage.map((text) => ({ kind: "usage", text }))),
    ClickedLine: ({ index, section }) => ({ model: toggle(model, index, section) }),
    FailedTurn: ({ error }) => ended(model, { kind: "error", text: error }),
    // Its output folded under it, like a command System Two ran (click to open); !! says it wasn't shared.
    CompletedShell: ({ command, share, output }) =>
      ended(model, { kind: "shell", text: `$ ${command}${share ? "" : "   (only for you: not given to empty-vessel)"}`, body: output }),
    CompletedStop: () => ({ model }),
    CompletedAnswer: () => ({ model }),
    CompletedSteer: () => ({ model }),
    CompletedFlag: () => ({ model }),
    SteerRead: ({ text }) => {
      const at = model.steering.indexOf(text)
      if (at < 0) return { model }
      return { model: print({ ...model, steering: model.steering.filter((_, i) => i !== at) }, { kind: "info", text: "  System Two has read it" }) }
    },
  })
