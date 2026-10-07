import { expect, test } from "bun:test"
import type { Scoped } from "../../src/learning/checks"
import { replyFor, resolveCommand, verdictOf } from "../../src/loop/handoff"

const saved: Scoped = { name: "tests-for", description: "d", template: "APP_MODE=test bun test {file}", passes: 1, failsInARow: 0, scope: "project" }
const args = (extra: object) => ({ finishes: true, ...extra })

test("resolveCommand: a plain command, a saved check filled in, or the problem to report", () => {
  expect(resolveCommand(args({ command: "bun test" }), [])).toEqual({ command: "bun test" })
  expect(resolveCommand(args({ check: { name: "tests-for", args: { file: "a.test.ts" } } }), [saved])).toEqual({ command: "APP_MODE=test bun test 'a.test.ts'", saved })
  expect(resolveCommand(args({ check: { name: "nope", args: {} } }), [saved])).toEqual({ problem: 'No saved check is named "nope". Saved: tests-for' })
  expect(resolveCommand(args({ check: { name: "tests-for", args: {} } }), [saved])).toEqual({ problem: 'Check "tests-for" needs a value for: file' })
  expect(resolveCommand(args({}), [])).toEqual({ problem: "Give a command, or a saved check with its args." })
})

test("verdictOf: System One's verdict, or the exit code when System One couldn't judge", () => {
  expect(verdictOf("broken", "exit 127\nnot found")).toBe("broken")
  expect(verdictOf("escalate", "exit 0\nok")).toBe("passed") // System One's fallback isn't a verdict
  expect(verdictOf("escalate", "exit 1\n1 fail")).toBe("failed")
  expect(verdictOf("passed", "exit 1\nTests: 1 failed")).toBe("failed") // a pass needs exit 0 too
  expect(verdictOf("passed", "exit 0 (timed out after 120s)\n")).toBe("failed")
})

test("replyFor: a finishing pass ends the turn; otherwise the output (or the failure message) goes back", () => {
  expect(replyFor("passed", args({ success: "Fixed." }), "bun test", "exit 0\n 7 pass")).toEqual({ answer: "Fixed.\n\n`bun test` passed:\n```\nexit 0\n 7 pass\n```", done: true })
  expect(replyFor("passed", args({ success: "Fixed." }), "bun test", "exit 0", false)).toEqual({ output: "System One judged this a pass, but not surely enough to finish for you: read the output and answer.\nexit 0" })
  expect(replyFor("passed", args({ finishes: false }), "bun test", "exit 0")).toEqual({ output: "System One judged this a pass.\nexit 0" })
  expect(replyFor("failed", args({ failure: "Still failing." }), "bun test", "exit 1")).toEqual({ answer: "Still failing.", done: false })
  expect(replyFor("broken", args({}), "bun tset", "exit 1")).toEqual({ output: "System One judged this broken (the command itself didn't run).\nexit 1" })
})
