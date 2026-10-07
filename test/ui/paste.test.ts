import { expect, test } from "bun:test"
import { init, Message, update } from "../../src/ui/tui/app"

test("large pastes collapse but send their full text", () => {
  for (const text of ["x".repeat(1_001), Array(11).fill("line").join("\n")]) {
    const pasted = update(init("status"), Message.PastedText({ text })).model
    expect(pasted.input).toBe("[Text #1]")
    expect(pasted.pastes).toEqual([{ label: "[Text #1]", text }])

    const sent = update(pasted, Message.PressedKey({ key: "\r" }))
    expect(sent.commands).toMatchObject([{ name: "RunTurn", args: { input: text } }])
    expect(sent.model.printed.at(-1)?.text).toBe("[Text #1]")
    expect(sent.model.pastes).toEqual([])
  }
})

test("pastes at the size limits stay visible", () => {
  for (const text of ["x".repeat(1_000), Array(10).fill("line").join("\n")]) {
    const pasted = update(init("status"), Message.PastedText({ text })).model
    expect(pasted.input).toBe(text)
    expect(pasted.pastes).toEqual([])
  }
})

test("multiple pastes keep separate labels; deleting one excludes its text", () => {
  const first = "a".repeat(1_001)
  const second = "b".repeat(1_001)
  let model = update(init("s"), Message.PastedText({ text: first })).model
  model = update(model, Message.PastedText({ text: second })).model
  expect(model.input).toBe("[Text #1][Text #2]")

  model = update(model, Message.PressedKey({ key: "\x7f" })).model
  expect(model.input).toBe("[Text #1]")
  const sent = update(model, Message.PressedKey({ key: "\r" }))
  expect(sent.commands).toMatchObject([{ name: "RunTurn", args: { input: first } }])
})

test("queued messages keep the full paste after draft storage is cleared", () => {
  const text = "queued ".repeat(200)
  const pasted = update({ ...init("s"), running: true }, Message.PastedText({ text })).model
  const queued = update(pasted, Message.PressedKey({ key: "\t" })).model // Tab: for after the turn
  expect(queued.queued).toEqual([text])
  expect(queued.pastes).toEqual([])

  const sent = update(queued, Message.CompletedTurn({ reply: "done", usage: [] }))
  expect(sent.commands).toMatchObject([{ name: "RunTurn", args: { input: text } }])
})

test("answering a question expands its paste and preserves the interrupted draft", () => {
  const draftText = "draft ".repeat(200)
  const answerText = "answer ".repeat(200)
  let model = update(init("s"), Message.PastedText({ text: draftText })).model
  model = update(model, Message.AskedUser({ question: "Details?", options: [] })).model
  model = update(model, Message.PastedText({ text: answerText })).model
  expect(model.input).toBe("[Text #2]")

  const answered = update(model, Message.PressedKey({ key: "\r" }))
  expect(answered.commands).toMatchObject([{ name: "Answer", args: { answer: answerText } }])
  expect(answered.model.input).toBe("[Text #1]")
  const sent = update(answered.model, Message.PressedKey({ key: "\r" }))
  expect(sent.commands).toMatchObject([{ name: "RunTurn", args: { input: draftText } }])
})

test("expansion leaves literal labels inside pasted content alone", () => {
  const text = "[Text #2] " + "x".repeat(1_001)
  let model = update(init("s"), Message.PastedText({ text })).model
  model = update(model, Message.PastedText({ text: "y".repeat(1_001) })).model
  model = update(model, Message.PressedKey({ key: "\x7f" })).model

  const sent = update(model, Message.PressedKey({ key: "\r" }))
  expect(sent.commands).toMatchObject([{ name: "RunTurn", args: { input: text } }])
})

test("image labels inside a folded paste still become file paths", () => {
  const text = "describe ".repeat(130) + "[Image #1]"
  let model = update(init("s"), Message.AttachedImages({ images: [{ label: "[Image #1]", path: "/tmp/photo.png" }] })).model
  model = update(model, Message.PastedText({ text })).model
  expect(model.input).toBe("[Text #1]")

  const sent = update(model, Message.PressedKey({ key: "\r" }))
  expect(sent.commands).toMatchObject([{ name: "RunTurn", args: { input: text.replace("[Image #1]", "/tmp/photo.png") } }])
})
