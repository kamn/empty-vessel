import { expect, test } from "bun:test"
import * as Story from "foldkit/story"
import { Commands, init, Message, type Model, update } from "../../src/ui/tui/app"
import { renderMarkdown } from "../../src/ui/tui/markdown"
import { highlight, keysOf, makeInputDecoder, makeScreen, selectedText } from "../../src/ui/tui/runtime"
import { live, printLine } from "../../src/ui/tui/view"

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, "")

const typed = (text: string) => Story.message(Message.PressedKey({ key: text }))
const enter = Story.message(Message.PressedKey({ key: "\r" }))
const ctrlC = Story.message(Message.PressedKey({ key: "\x03" }))

test("Enter starts a turn; its reply and usage are printed, and the prompt comes back", () => {
  Story.story(update, Story.given(init("status")),
    typed("fix the tests"), enter,
    Story.model((m: Model) => {
      expect(m.running).toBe(true)
      expect(m.input).toBe("")
      expect(m.printed.at(-1)).toEqual({ kind: "user", text: "fix the tests" })
    }),
    Story.Command.expectExact(Commands.RunTurn),
    Story.Command.resolve(Commands.RunTurn, Message.CompletedTurn({ reply: "done", usage: ["turn    0:00:01"], total: "session 0:00:01" })),
    Story.model((m: Model) => {
      expect(m.running).toBe(false)
      expect(m.total).toBe("session 0:00:01") // shown under the input box
      expect(m.printed.slice(-2).map((l) => l.kind)).toEqual(["reply", "usage"])
    }),
  )
})

test("during a turn, events print immediately and activity shows live; completion does not duplicate events", () => {
  Story.story(update, Story.given({ ...init("s"), running: true }),
    Story.message(Message.GotEvent({ kind: "activity", depth: 0, text: "System One is choosing step 2" })),
    Story.message(Message.GotEvent({ kind: "step", depth: 1, text: "step 2: escalate" })),
    Story.model((m: Model) => {
      expect(m.activity).toBe("System One is choosing step 2")
      expect(m.printed).toEqual([{ kind: "step", text: "  step 2: escalate" }])
    }),
    Story.message(Message.CompletedTurn({ reply: "ok", usage: [] })),
    Story.model((m: Model) => expect(m.printed.map((l) => l.kind)).toEqual(["step", "reply"])),
  )
})

test("a message sent with Tab during a turn is queued, and goes out when the turn is done (not when it was stopped)", () => {
  Story.story(update, Story.given({ ...init("s"), running: true }),
    typed("and then this"), Story.message(Message.PressedKey({ key: "\t" })),
    Story.model((m: Model) => expect([m.queued, m.input]).toEqual([["and then this"], ""])),
    Story.message(Message.CompletedTurn({ reply: "first done", usage: [] })),
    Story.Command.expectExact(Commands.RunTurn),
    Story.model((m: Model) => expect([m.running, m.queued, m.printed.at(-1)]).toEqual([true, [], { kind: "user", text: "and then this" }])),
    Story.Command.resolve(Commands.RunTurn, Message.CompletedTurn({ reply: "second done", usage: [] })),
  )
  Story.story(update, Story.given({ ...init("s"), running: true, stopping: true, queued: ["later"] }),
    Story.message(Message.CompletedTurn({ reply: "(stopped)", usage: [] })),
    Story.Command.expectNone(),
    Story.model((m: Model) => expect([m.running, m.queued, m.input]).toEqual([false, [], "later"])),
  )
})

test("Enter during a turn sends the message to System Two mid-run; read, it says so; unread when the turn ends, it goes next", () => {
  Story.story(update, Story.given({ ...init("s"), running: true }),
    typed("use the v2 API"), enter,
    Story.Command.expectExact(Commands.Steer),
    Story.model((m: Model) => expect([m.steering, m.queued, m.printed.at(-2)]).toEqual([["use the v2 API"], [], { kind: "user", text: "use the v2 API" }])),
    Story.Command.resolve(Commands.Steer, Message.CompletedSteer()),
    Story.message(Message.SteerRead({ text: "use the v2 API" })),
    Story.model((m: Model) => expect([m.steering, m.printed.at(-1)?.text]).toEqual([[], "  System Two has read it"])),
    Story.message(Message.CompletedTurn({ reply: "done", usage: [] })),
    Story.Command.expectNone(),
  )
  Story.story(update, Story.given({ ...init("s"), running: true }),
    typed("also the docs"), enter,
    Story.Command.resolve(Commands.Steer, Message.CompletedSteer()),
    Story.message(Message.CompletedTurn({ reply: "done", usage: [] })), // finished before reading it
    Story.Command.expectExact(Commands.RunTurn),
    Story.model((m: Model) => expect([m.steering, m.printed.some((l) => l.text.includes("System Two finished first"))]).toEqual([[], true])),
    Story.Command.resolve(Commands.RunTurn, Message.CompletedTurn({ reply: "docs done", usage: [] })),
  )
})

test("/flag marks the moment, mid-run or idle: it's recorded with where the turn is, never steers or interrupts it", () => {
  Story.story(update, Story.given({ ...init("s"), running: true, activity: "running bun test" }),
    typed("/flag it's rereading again"), enter,
    Story.Command.expectExact(Commands.Flag),
    Story.model((m: Model) => expect([m.running, m.steering, m.input, m.printed.at(-1)?.text]).toEqual([true, [], "", "  flagged"])),
    Story.Command.resolve(Commands.Flag, Message.CompletedFlag()),
    Story.message(Message.CompletedTurn({ reply: "done", usage: [] })),
    Story.Command.expectNone(), // nothing left to send: the flag wasn't a message
  )
  Story.story(update, Story.given(init("s")),
    typed("/flag"), enter,
    Story.Command.resolve(Commands.Flag, Message.CompletedFlag()),
    Story.model((m: Model) => expect(m.running).toBe(false)),
  )
})

test("a long body is folded to a few lines; a click on it (or Ctrl+O, for the newest) opens it where it is, a click closes it", () => {
  const script = { kind: "system-two", text: "  system two ran: cat <<EOF", body: "1\n2\n3\n4\n5\n6" }
  expect(printLine(script).map(plain)).toEqual(["  ● cat <<EOF", "    │ 1", "    │ 2", "    │ 3", "    │ 4", "    … 2 more lines · click to expand"])
  Story.story(update, Story.given(init("s")),
    Story.message(Message.GotEvent({ kind: "system-two", depth: 0, text: script.text, body: script.body })),
    Story.message(Message.PressedKey({ key: "\x0f" })),
    Story.model((m: Model) => expect(printLine(m.printed.at(-1)!).length).toBe(7)), // the title and all six lines
    Story.message(Message.ClickedLine({ index: 0 })),
    Story.model((m: Model) => expect(printLine(m.printed[0]!).length).toBe(6)), // closed again
    Story.message(Message.ClickedLine({ index: 0 })),
    Story.model((m: Model) => expect(m.printed[0]!.open).toBe(true)),
  )
})

test("replies are drawn as markdown: headings, lists, code, links", () => {
  const out = renderMarkdown("# Title\n- one **big** `x`\n```ts\nconst a = 1\n```\nsee [docs](https://example.com)").map(plain)
  expect(out).toEqual(["Title", "• one big x", "╭─ ts", "│ const a = 1", "╰─", "see docs"])
})

test("Ctrl+C stops a running turn (once), clears a typed line, and leaves on an empty one", () => {
  Story.story(update, Story.given({ ...init("s"), running: true }),
    ctrlC, Story.Command.expectExact(Commands.StopTurn),
    Story.model((m: Model) => expect(m.stopping).toBe(true)),
    Story.Command.resolve(Commands.StopTurn, Message.CompletedStop()),
  )
  Story.story(update, Story.given({ ...init("s"), running: true, stopping: true }), ctrlC, Story.Command.expectNone())
  Story.story(update, Story.given(init("s")),
    typed("half a thought"), ctrlC, Story.model((m: Model) => expect([m.input, m.exiting]).toEqual(["", false])),
    ctrlC, Story.model((m: Model) => expect(m.exiting).toBe(true)),
  )
})

test("a question from the loop is answered by the next line, not sent as a new turn", () => {
  Story.story(update, Story.given({ ...init("s"), running: true }),
    Story.message(Message.AskedUser({ question: "Deploy?", options: ["Yes", "No"] })),
    typed("1"), enter,
    Story.Command.expectExact(Commands.Answer),
    Story.model((m: Model) => expect([m.asking, m.running]).toEqual([null, true])),
    Story.Command.resolve(Commands.Answer, Message.CompletedAnswer()),
  )
})

test("Up and Down walk through earlier inputs", () => {
  Story.story(update, Story.given({ ...init("s"), history: ["one", "two"], historyAt: 2 }),
    Story.message(Message.PressedKey({ key: "\x1b[A" })), Story.model((m: Model) => expect(m.input).toBe("two")),
    Story.message(Message.PressedKey({ key: "\x1b[A" })), Story.model((m: Model) => expect(m.input).toBe("one")),
    Story.message(Message.PressedKey({ key: "\x1b[B" })), Story.message(Message.PressedKey({ key: "\x1b[B" })),
    Story.model((m: Model) => expect(m.input).toBe("")),
  )
})

test("terminal input splits into keys; a bracketed paste stays one piece", () => {
  expect(keysOf("ab\r")).toEqual(["ab", "\r"])
  expect(keysOf("\x1b[A\x1b[A\x7f")).toEqual(["\x1b[A", "\x1b[A", "\x7f"])
  expect(keysOf("\x1b[200~line one\r\nline two\x1b[201~")).toEqual(["line one\nline two"])
})

test("paste markers can split anywhere without releasing paste contents as keys", () => {
  const wrapped = "\x1b[200~one\r\ntwo\x1b[201~"

  for (let split = 1; split < wrapped.length; split++) {
    const decode = makeInputDecoder()
    expect(decode(wrapped.slice(0, split))).toEqual([])
    expect(decode(wrapped.slice(split))).toEqual([{ key: "one\ntwo", paste: true }])
  }

  const decode = makeInputDecoder()
  expect([...wrapped].flatMap(char => decode(char))).toEqual([{ key: "one\ntwo", paste: true }])
})

test("typing, multiple pastes, and Enter keep their order in one chunk", () => {
  const decode = makeInputDecoder()
  expect(decode("before\x1b[200~first\x1b[201~between\x1b[200~second\x1b[201~\r")).toEqual([
    { key: "before", paste: false }, { key: "first", paste: true },
    { key: "between", paste: false }, { key: "second", paste: true }, { key: "\r", paste: false },
  ])
})

test("pasted newlines and control characters never run keyboard commands", () => {
  for (const text of ["\r", "\n", "\x03", "\x15", "\x1b[A", ""]) {
    const next = update({ ...init("ready"), input: "draft" }, Message.PastedText({ text }))
    expect(next.commands ?? []).toEqual([])
    expect(next.model.input.startsWith("draft")).toBe(true)
  }

  const pasted = update(init("ready"), Message.PastedText({ text: "one\r\ntwo\r" }))
  expect(pasted.model.input).toBe("one\ntwo\n")
  expect(pasted.commands ?? []).toEqual([])
  const sent = update(pasted.model, Message.PressedKey({ key: "\r" }))
  expect(sent.commands?.length).toBe(1)
})

test("a paste split across terminal chunks does not submit the draft", () => {
  const chunks = ["\x1b[200~line one", "\rline two\x1b[201~"]
  const decode = makeInputDecoder()
  let model = init("ready")
  const commands: unknown[] = []

  for (const chunk of chunks) {
    for (const { key, paste } of decode(chunk)) {
      const next = update(model, paste ? Message.PastedText({ text: key }) : Message.PressedKey({ key }))
      model = next.model
      commands.push(...(next.commands ?? []))
    }
  }

  expect(commands).toEqual([])
  expect(model.input).toBe("line one\nline two")
})

test("the live area fits the width, and the cursor sits after the typed text inside the box", () => {
  const { lines, cursor } = live({ ...init("x".repeat(200)), input: "hello" }, 40)
  expect(plain(lines[cursor.row]!)).toBe(`│ › hello${" ".repeat(28)} │`)
  expect(cursor.col).toBe(9)
  expect(lines.every((l) => plain(l).length <= 40)).toBe(true)
})

test("the logo is the first thing in the conversation when the TUI takes over the screen, shown as it is", () => {
  const banner = "\x1b[38;5;209m無極\x1b[0m · empty-vessel"
  const model = init("status", banner)
  expect(model.printed).toEqual([{ kind: "banner", text: banner }])
  expect(printLine(model.printed[0]!)).toEqual([banner]) // its colours kept, nothing added
  expect(init("status").printed).toEqual([])
})

test("a pasted image shows as its label; sending gives the loop the path and prints the label", () => {
  let model: Model = init("status")
  model = update(model, Message.AttachedImages({ images: [{ label: "[Image #1]", path: "/Users/me/Desktop/Screen Shot.png" }] })).model
  model = update(model, Message.PressedKey({ key: "what's wrong in [Image #1]?" })).model
  expect(model.input).toBe("what's wrong in [Image #1]?")

  const sent = update(model, Message.PressedKey({ key: "\r" }))
  expect(JSON.stringify(sent.commands)).toContain(String.raw`what's wrong in /Users/me/Desktop/Screen\\ Shot.png?`) // escaped, as a terminal pastes it
  expect(sent.model.printed.at(-1)).toEqual({ kind: "user", text: "what's wrong in [Image #1]?" })
  expect(sent.model.attached).toEqual([])
})

test("the cursor: typing in the middle, a line break with \\ Enter, Up between lines, and the cursor drawn where it is", () => {
  Story.story(update, Story.given(init("status")),
    typed("fix bug"), typed("\x1b[D"), typed("\x1b[D"), typed("\x1b[D"), typed("the "),
    Story.model((m: Model) => expect(m.input).toBe("fix the bug")),
    typed("\x05"), typed("\\"), enter, typed("then test"),
    Story.model((m: Model) => {
      expect(m.running).toBe(false) // \ Enter made a line break, it didn't send
      expect(m.input).toBe("fix the bug\nthen test")
      const { lines, cursor } = live(m, 80)
      expect(plain(lines[cursor.row]!).slice(0, cursor.col)).toBe("│   then test")
    }),
    typed("\x1b[A"), typed("\x01"), typed("\x1b\r"),
    Story.model((m: Model) => {
      expect(m.input).toBe("\nfix the bug\nthen test") // Up moved to the first line; Alt+Enter broke it at the start
      const { lines, cursor } = live(m, 80)
      expect(plain(lines[cursor.row]!).slice(0, cursor.col + 3)).toBe("│   fix") // at the start of "fix the bug", now line 2
    }),
  )
  expect(keysOf("\x1bOH\x1b[1;3D\x1b\rx")).toEqual(["\x1bOH", "\x1b[1;3D", "\x1b\r", "x"]) // Alt+Enter is one key
})

test("selecting with the mouse: the text copied (no colour codes, no padding), and the highlight keeps the colours around it", () => {
  const lines = ["\x1b[31mred\x1b[0m and plain   ", "second line", "third"]
  expect(selectedText(lines, { from: [0, 4], to: [1, 5] })).toBe("and plain\nsecond")
  expect(selectedText(lines, { from: [2, 2], to: [0, 1] })).toBe("ed and plain\nsecond line\nthi") // dragged upwards
  expect(highlight(lines[0]!, 0, { from: [0, 1], to: [0, 5] })).toBe("\x1b[31mr\x1b[7med an\x1b[0m\x1b[31m\x1b[0md plain   ")
  expect(highlight(lines[2]!, 2, { from: [0, 1], to: [1, 5] })).toBe("third") // not in the selection
})

test("a printed line's rows are kept between redraws, and worked out again when the width changes", () => {
  const model = { ...init("status"), printed: [{ kind: "info", text: "word ".repeat(30).trim() }] }
  const out = process.stdout as unknown as { write: unknown; columns: number }
  const { write, columns } = out
  let frame = ""
  out.write = (s: string) => { frame = plain(s); return true }

  try {
    const screen = makeScreen()
    out.columns = 41; screen.draw(model)
    const narrow = frame.split("\r\n").filter((l) => l.includes("word")).length
    out.columns = 201; screen.draw(model)
    const wide = frame.split("\r\n").filter((l) => l.includes("word")).length

    expect([narrow, wide]).toEqual([4, 1])
  } finally { out.write = write; out.columns = columns }
})

test("a click names the printed line on that screen row; a drag doesn't", () => {
  const model = { ...init("status"), printed: [{ kind: "info", text: "hello" }, { kind: "system-two", text: "system two ran: ls", body: "1\n2\n3\n4\n5\n6" }] }
  const out = process.stdout as unknown as { write: unknown; rows: number }
  const { write, rows } = out
  let frame = ""
  out.write = (s: string) => { frame = plain(s); return true }

  try {
    const screen = makeScreen()
    out.rows = 30; screen.draw(model)
    const at = (text: string) => frame.replace(/^\x1b\[\?2026h/, "").split("\r\n").findIndex((l) => l.includes(text))
    const click = (row: number) => { screen.select("press", [row, 3]); return screen.select("release", [row, 3]) }

    expect(click(at("more lines"))).toEqual({ clicked: 1 })
    expect(click(at("hello"))).toEqual({ clicked: 0 })
    expect(click(at("status"))).toEqual({ clicked: -1 }) // under the conversation: the input box, the status
    screen.select("press", [at("hello"), 0])
    expect(screen.select("release", [at("hello"), 4])).toEqual({ copied: "hello" })
  } finally { out.write = write; out.rows = rows }
})

test("!command and !!command run a command (shared, or only for you), not a turn; its output folds under it; Esc stops a running turn, and does nothing when idle", () => {
  Story.story(update, Story.given(init("status")),
    typed("!npm test"), enter,
    Story.model((m: Model) => expect(m.activity).toBe("running npm test")),
    Story.Command.resolve(Commands.RunShell, Message.CompletedShell({ command: "npm test", share: true, output: "exit 0\n1 pass\n2 pass\n3 pass\n4 pass\n5 pass" })),
    Story.model((m: Model) => {
      const shown = m.printed.find((l) => l.kind === "shell")!
      expect(shown.text).toBe("$ npm test")
      expect(printLine(shown).at(-1)).toContain("more lines") // folded: click to open
      expect(m.running).toBe(false)
    }),
  )
  // A message queued behind a command goes out when it's done.
  Story.story(update, Story.given({ ...init("status"), running: true, queued: ["next message"] }),
    Story.message(Message.CompletedShell({ command: "ls", share: true, output: "exit 0" })),
    Story.model((m: Model) => expect(m.running).toBe(true)),
    Story.Command.expectExact(Commands.RunTurn),
    Story.Command.resolve(Commands.RunTurn, Message.CompletedTurn({ reply: "done", usage: [] })),
  )
  Story.story(update, Story.given(init("status")),
    typed("!!git status"), enter,
    Story.Command.resolve(Commands.RunShell, Message.CompletedShell({ command: "git status", share: false, output: "exit 0\nclean" })),
    Story.model((m: Model) => expect(m.printed.find((l) => l.kind === "shell")!.text).toContain("only for you")),
    Story.message(Message.PressedKey({ key: "\x1b" })),
    Story.model((m: Model) => expect(m.stopping).toBe(false)), // nothing running: Esc does nothing
  )
  Story.story(update, Story.given({ ...init("status"), running: true }),
    Story.message(Message.PressedKey({ key: "\x1b" })),
    Story.model((m: Model) => expect(m.stopping).toBe(true)),
    Story.Command.expectExact(Commands.StopTurn),
    Story.Command.resolve(Commands.StopTurn, Message.CompletedStop()),
  )
})

test("the running log keeps notes, thinking, cells and steering in arrival order", () => {
  let model = { ...init("status"), running: true }
  const events = [
    { kind: "system-two", depth: 0, text: "thought: Inspect the renderer", body: "Inspect the renderer" },
    { kind: "note", depth: 0, text: "I found the issue." },
    { kind: "system-two", depth: 0, text: "system two ran: kernel: inspect", body: "1\n── result ──\n42" },
    ...Array.from({ length: 7 }, (_, i) => ({ kind: "step", depth: 0, text: `step ${i}` })),
  ]
  for (const event of events) {
    model = update(model, Message.GotEvent(event)).model
    expect(model.printed.at(-1)?.text).toBe(event.text)
  }
  expect(live(model, 100).lines.join("\n")).not.toContain("step 6")
  model = update(model, Message.ClickedLine({ index: 2, section: "result" })).model
  expect(model.printed[2]!.resultOpen).toBe(true)
  model = update({ ...model, input: "Keep the notes visible" }, Message.PressedKey({ key: "\r" })).model
  expect(model.printed.at(-2)?.text).toBe("Keep the notes visible")
  const before = model.printed
  const finished = update(model, Message.CompletedTurn({ reply: "Done", usage: [] })).model
  expect(finished.printed.slice(0, before.length)).toEqual([...before])
  expect(finished.printed.filter((line) => line.text === "I found the issue.")).toHaveLength(1)
  expect(finished.printed.filter((line) => line.kind === "system-two")).toHaveLength(2)
})

test("failed and stopped turns preserve their already-visible log without duplicates", () => {
  for (const [ending, reply] of [[Message.FailedTurn({ error: "backend failed" }), "backend failed"], [Message.CompletedTurn({ reply: "(stopped)", usage: [] }), "(stopped)"]] as const) {
    let model = { ...init("status"), running: true }
    model = update(model, Message.GotEvent({ kind: "note", depth: 0, text: "Working on it." })).model
    model = update(model, Message.GotEvent({ kind: "system-two", depth: 1, text: "thought: Check the file", body: "Check the file" })).model
    model = update(model, Message.PressedKey({ key: "\x1b" })).model
    const finished = update(model, ending).model
    expect(finished.running).toBe(false)
    expect(finished.printed.map((line) => line.text)).toEqual(["Working on it.", "  thought: Check the file", reply])
  }
})
