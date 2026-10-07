import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as Story from "foldkit/story"
import { Commands, init, Message, type Model, update } from "../../src/ui/tui/app"
import { live } from "../../src/ui/tui/view"
import { answer, newRun } from "../../src/system-two/relay"

const asked = Message.AskedUser({ question: "Deploy?", options: ["Yes", "No"] })
const key = (key: string) => Message.PressedKey({ key })

test("picker arrows select without recalling history; Enter answers and restores the draft", () => {
  Story.story(update, Story.given({ ...init("s"), running: true, input: "draft", history: ["old"], historyAt: 1 }),
    Story.message(asked),
    Story.message(key("\x1b[B")),
    Story.model((m: Model) => {
      expect(m.selectedOption).toBe(1)
      expect(m.input).toBe("")
      expect(m.historyAt).toBe(1)
      const screen = live(m, 100).lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "")
      expect(screen).toContain("❯ 2. No")
      expect(screen).toContain("Optional note")
      expect(screen).not.toContain("Type to queue")
    }),
    Story.message(key("\r")),
    Story.Command.expectExact(Commands.Answer),
    Story.model((m: Model) => {
      expect(m.printed.at(-1)?.text).toBe("No")
      expect(m.input).toBe("draft")
      expect(m.asking).toBeNull()
      expect(m.running).toBe(true)
    }),
    Story.Command.resolve(Commands.Answer, Message.CompletedAnswer()),
  )
})

test("picker accepts custom text, resets for the next question, and clamps Up", () => {
  let m = update({ ...init("s"), running: true }, asked).model
  m = update(m, key("\x1b[A")).model
  expect(m.selectedOption).toBe(0)
  m = update(m, key("\x1b[B")).model
  m = update(m, key("\x1b[B")).model
  m = update(m, key("\x1b[B")).model
  expect(m.selectedOption).toBe(2)
  expect(update(m, key("\r")).model.asking).not.toBeNull()
  m = update(m, key("Not yet")).model
  m = update(m, key("\r")).model
  expect(m.printed.at(-1)?.text).toBe("Not yet")
  m = update(m, asked).model
  expect(m.selectedOption).toBe(0)
  expect(m.input).toBe("")
  m = update(m, key("\r")).model
  expect(m.printed.at(-1)?.text).toBe("Yes")
})

test("stopping a question restores the draft and removes the picker", () => {
  let m = update({ ...init("s"), running: true, input: "later" }, asked).model
  m = update(m, key("\x03")).model
  expect(m.stopping).toBe(true)
  m = update(m, Message.CompletedTurn({ reply: "stopped", usage: [] })).model
  expect(m.asking).toBeNull()
  expect(m.input).toBe("later")
})

test("Claude ask_user returns answers without ending the run; invalid input never reaches the hook", () =>
  Effect.runPromise(Effect.gen(function* () {
    const state = newRun()
    let calls = 0
    const hooks = { askUser: () => Effect.sync(() => { calls++; return '[{"question":"Deploy?","answer":"No"}]' }) }
    const args = { questions: [{ question: "Deploy?", options: ["Yes", "No"] }] }
    expect(yield* answer("ask_user", args, hooks, state)).toContain('"answer":"No"')
    expect(state.ended).toBeUndefined()

    for (const bad of [{ questions: [] }, { questions: [{ question: "", options: ["Yes"] }] }, { questions: [{ question: "Q", options: [] }] }, { questions: [{ question: "Q", options: [""] }] }, { questions: [{ question: "Q", options: ["a", "b", "c", "d"] }] }]) {
      expect(yield* answer("ask_user", bad, hooks, state)).toStartWith("invalid arguments")
    }

    expect(calls).toBe(1)
    expect(yield* answer("ask_user", args, {}, state)).toContain("main agent")
  })),
)


test("a selected option and optional note reach the runner together", () =>
  Effect.runPromise(Effect.gen(function* () {
    const { TurnRunner } = yield* Effect.promise(() => import("../../src/ui/tui/app"))
    const m = update({ ...init("s"), running: true }, asked).model

    for (const [input, expected] of [
      ["Focus on login", { answer: "No", note: "Focus on login" }],
      ["2", { answer: "No", note: "2" }],
      ["   ", { answer: "No" }],
    ] as const) {
      const result = update({ ...m, selectedOption: 1, input }, key("\r"))
      const command = result.commands![0]!
      let received: unknown
      yield* command.effect.pipe(Effect.provideService(TurnRunner, {
        run: () => Effect.succeed({ reply: "", usage: [] }),
        shell: () => Effect.succeed(""),
        stop: Effect.void,
        answer: (reply) => Effect.sync(() => { received = reply }),
        steer: () => Effect.void,
        flag: () => Effect.void,
      }))
      expect(received).toEqual(expected)
      expect(result.model.printed.at(-1)?.text).toBe(input.trim() ? `No\nNote: ${input}` : "No")
    }
  })),
)
