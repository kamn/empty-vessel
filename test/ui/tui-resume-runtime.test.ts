import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { init, Message, type Model } from "../../src/ui/tui/app"
import { runTui } from "../../src/ui/tui/runtime"
import { loadView, saveView } from "../../src/ui/tui/session"

// Drive the actual event loop without taking ownership of the test runner's terminal.
test("runtime checkpoints comments, cells, results and draft; reopening draws them without running commands", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ev-view-runtime-"))
  const stdin = process.stdin
  const stdout = process.stdout
  const keys = ["setRawMode", "setEncoding", "on", "off", "resume", "pause"] as const
  const descriptors = keys.map(key => [key, Object.getOwnPropertyDescriptor(stdin, key)] as const)
  const writeDescriptor = Object.getOwnPropertyDescriptor(stdout, "write")
  const frames: string[] = []
  const saved: Model[] = []

  try {
    for (const key of keys) Object.defineProperty(stdin, key, { configurable: true, value: () => stdin })
    Object.defineProperty(stdout, "write", { configurable: true, value: (text: string) => { frames.push(String(text)); return true } })
    const controller = new AbortController()
    const checkpoint = (model: Model) => {
      saved.push(model)
      saveView(dir, model)
      if (model.input === "unfinished draft") controller.abort()
    }
    const cell = { kind: "system-two", depth: 0, text: "cell 1: inspect", body: "const answer = 42\n\n$1 = 42", summary: "Inspect the answer" }

    const outcome = await Effect.runPromiseExit(runTui(init("first status"), dispatch => {
      dispatch(Message.GotEvent({ kind: "note", depth: 0, text: "Preserve this comment" }))
      dispatch(Message.GotEvent(cell))
      dispatch(Message.CompletedTurn({ reply: "The result is 42", usage: ["turn usage"] }))
      dispatch(Message.Ticked())
      dispatch(Message.PressedKey({ key: "unfinished draft" }))
    }, { checkpoint }) as Effect.Effect<void>, { signal: controller.signal })

    expect(outcome._tag).toBe("Failure") // the terminal was closed, not a normal turn completion
    // Four real messages plus the exit finalizer; the spinner is not a disk write.
    expect(saved).toHaveLength(5)
    const restored = loadView(dir, init("new status", "new banner"))
    expect(restored.printed).toEqual(saved.at(-1)!.printed)
    expect(restored.input).toBe("unfinished draft")
    expect(restored.status).toBe("new status")
    expect(restored.exiting).toBe(false)
    expect(restored.running).toBe(false)
    frames.length = 0

    // No TurnRunner is provided: replay must not need one or launch any command.
    await Effect.runPromise(runTui(restored, dispatch => {
      dispatch(Message.PressedKey({ key: "\x15" }))
      dispatch(Message.PressedKey({ key: "\x04" }))
    }) as Effect.Effect<void>)
    const output = frames.join("")
    expect(output).toContain("Preserve this comment")
    expect(output).toContain("The result is 42")
    expect(output).toContain("unfinished draft")
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(stdin, key, descriptor)
      else Reflect.deleteProperty(stdin, key)
    }
    if (writeDescriptor) Object.defineProperty(stdout, "write", writeDescriptor)
    else Reflect.deleteProperty(stdout, "write")
    rmSync(dir, { recursive: true, force: true })
  }
})
