import { expect, test } from "bun:test"
import * as Story from "foldkit/story"
import { Commands, init, Message, type Model, update } from "../../src/ui/tui/app"
import { suggestions } from "../../src/ui/tui/completion"
import { live } from "../../src/ui/tui/view"
import { widthOf } from "../../src/ui/tui/style"

const items = [
  { command: "/skills", description: "List installed skills" },
  { command: "/skills reload", description: "Reload skills" },
  { command: "/skills import", description: "Import skills" },
  { command: "/skill review", description: "Review code" },
  { command: "/skill refactor", description: "Refactor code" },
  { command: "/help", description: "Get help" },
  { command: "/exit", description: "Leave" },
]
const initial = () => init("status", ["older", "newer"], "banner", items)
const key = (m: Model, key: string) => update(m, Message.PressedKey({ key })).model
const typed = (key: string) => Story.message(Message.PressedKey({ key }))
const text = (m: Model, width = 80) => live(m, width).lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "")

test("slash filters commands and descriptions; five rows scroll with keyboard selection", () => {
  let m = key(initial(), "/")
  expect(suggestions(m)).toEqual(items)
  expect(text(m)).toContain("List installed skills")
  expect(text(m)).not.toContain("Get help")
  for (let i = 0; i < 5; i++) m = key(m, "\x1b[B")
  expect(text(m)).toContain("❯ /help")
  expect(text(m)).not.toContain("List installed skills")
  m = key(m, "\x1b[A")
  expect(key(m, "\t").input).toBe("/skill refactor")
  expect(suggestions(key(initial(), "/skills")).map(i => i.command)).toEqual(["/skills", "/skills reload", "/skills import"])
  expect(suggestions(key(initial(), "/skill r")).map(i => i.command)).toEqual(["/skill review", "/skill refactor"])
  expect(suggestions(key(initial(), "/missing"))).toEqual([])
})

test("Story: Enter accepts partial suggestion, second Enter sends; exact skills sends immediately", () => {
  Story.story(update, Story.given(initial()), typed("/skills re"), typed("\r"),
    Story.Command.expectNone(),
    Story.model((m: Model) => { expect(m.input).toBe("/skills reload"); expect(m.running).toBe(false) }),
    typed("\r"), Story.Command.expectExact(Commands.RunTurn),
    Story.Command.resolve(Commands.RunTurn, Message.CompletedTurn({ reply: "reloaded", usage: [] })))
  Story.story(update, Story.given(initial()), typed("/skills"), typed("\r"),
    Story.Command.expectExact(Commands.RunTurn),
    Story.Command.resolve(Commands.RunTurn, Message.CompletedTurn({ reply: "listed", usage: [] })))
})

test("Tab never submits; editing reopens after acceptance or Escape; history remains available", () => {
  let m = key(key(initial(), "/ski"), "\t")
  expect(m.input).toBe("/skills")
  expect(m.running).toBe(false)
  expect(suggestions(m)).toEqual([])
  m = key(m, " ")
  expect(suggestions(m)).toHaveLength(2)
  m = key(m, "\x1b")
  expect(m.input).toBe("/skills ")
  expect(suggestions(m)).toEqual([])
  expect(key(m, "\x1b[A").input).toBe("newer")
  expect(key(key(initial(), "\x1b[A"), "\x1b[B").input).toBe("")
  expect(suggestions(key(m, "r"))).toHaveLength(1)
})

test("catalog refresh resets selection and immediately updates the view", () => {
  let m = key(key(initial(), "/"), "\x1b[B")
  m = update(m, Message.UpdatedCompletions({ items: [{ command: "/fresh", description: "Fresh command" }] })).model
  expect(m.completionSelected).toBe(0)
  expect(text(m)).toContain("Fresh command")
  expect(key(m, "\t").input).toBe("/fresh")
  expect(init("status", undefined, items).completions).toEqual(items)
  expect(init("status", "banner", items).completions).toEqual(items)
  expect(init("status").completions).toEqual([])
  expect(initial().history).toEqual(["older", "newer"])
  expect(init("status", "old banner").printed[0]?.text).toBe("old banner")
})

test("busy and question states hide suggestions without stealing steering or option keys", () => {
  const busy = { ...key(initial(), "/ski"), running: true }
  expect(suggestions(busy)).toEqual([])
  expect(text(busy)).not.toContain("List installed skills")
  expect(key(busy, "\t").queued).toEqual(["/ski"])
  expect(update(busy, Message.PressedKey({ key: "\r" })).commands?.[0]?.name).toBe(Commands.Steer.name)
  let asking = update(initial(), Message.AskedUser({ question: "Which?", options: ["one", "two"] })).model
  asking = key(asking, "/")
  expect(suggestions(asking)).toEqual([])
  expect(key(asking, "\x1b[B").selectedOption).toBe(1)
})

test("cursor completion keeps arguments and Unicode; pasted text never submits", () => {
  let m = update(initial(), Message.PastedText({ text: "/skill rev file😀.ts" })).model
  expect(m.running).toBe(false)
  expect(suggestions(m)).toEqual([])
  for (const _ of Array.from(" file😀.ts")) m = key(m, "\x1b[D")
  m = key(m, "\t")
  expect(m.input).toBe("/skill review file😀.ts")
  expect(m.after).toBe(Array.from(" file😀.ts").length)
  expect(key(m, "!").input).toBe("/skill review! file😀.ts")
  m = { ...initial(), input: "/skills relod path\nsecond line", after: Array.from("od path\nsecond line").length }
  expect(key(m, "\t").input).toBe("/skills reload path\nsecond line")
  expect(suggestions({ ...initial(), input: "/skills\n/", after: 0 })).toEqual([])
  m = key(key(initial(), "/"), "\x1b")
  expect(suggestions(update(m, Message.PastedText({ text: "ski" })).model)).toHaveLength(5)
})

test("idle hint is discoverable; menu rows fit narrow widths and keep cursor in the input", () => {
  expect(text(initial())).toContain(" / commands")
  const m = key(initial(), "/")
  for (const width of [1, 5, 10, 30, 80]) {
    const area = live(m, width)
    const menu = area.lines.slice(area.cursor.row + 2, -1)
    expect(menu).toHaveLength(5)
    expect(menu.every(row => widthOf(row) <= width)).toBe(true)
  }
})
