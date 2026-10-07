import { expect, test } from "bun:test"
import { lastTurnStart, maskOutput, oldOutputs } from "../../src/system-two/thread"

const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] })
const call = (id: string, name: string, args: object) => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) })
const output = (id: string, text: string) => ({ type: "function_call_output", call_id: id, output: text })
const big = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`).join("\n")

const thread = (): Array<unknown> => [
  user("fix the cart"), call("a", "read", { path: "src/cart.ts" }), output("a", big(40)), call("b", "bash", { command: "ls" }), output("b", "a.ts"),
  user("now the money"), call("c", "read", { path: "src/money.ts" }), output("c", big(40)),
]

test("lastTurnStart: the last user message", () => {
  expect(lastTurnStart(thread())).toBe(5)
  expect(lastTurnStart([])).toBe(0)
})

test("oldOutputs: long tool outputs before the last turn, labelled with their call", () => {
  const found = oldOutputs(thread(), 5)
  expect(found.map((f) => f.index)).toEqual([2]) // "a.ts" is too short; out c is in the last turn
  expect(found[0]!.label).toStartWith('read {"path":"src/cart.ts"} → 40 lines, starting:\nline 1')
})

test("maskOutput: a stub in the thread, the full text in the stash, and never masked twice", () => {
  const t = thread(), stash = new Map<string, string>()
  const saved = maskOutput(t, oldOutputs(t, 5)[0]!, stash)
  expect(saved).toBeGreaterThan(900)
  expect((t[2] as { output: string }).output).toContain('more_output { id: "out1" }')
  expect(stash.get("out1")).toBe(big(40))
  expect(oldOutputs(t, 5)).toEqual([]) // already a stub
})

test("files gather put in an old user message count too, and are hidden one by one", () => {
  const t: Array<unknown> = [user(`Goal: x\n\n<file path="src/a.ts">\n${big(40)}\n</file>\n\n<file path="src/b.ts">\n${big(30)}\n</file>`), user("next")]
  const found = oldOutputs(t, 1)
  expect(found.map((f) => f.file)).toEqual(["src/a.ts", "src/b.ts"])
  const stash = new Map<string, string>()
  maskOutput(t, found[0]!, stash)
  const text = (t[0] as { content: Array<{ text: string }> }).content[0]!.text
  expect(text).toContain('<file path="src/a.ts">\n[hidden by System One')
  expect(text).toContain(big(30)) // b.ts untouched
  expect(stash.get("out1")).toBe(big(40))
  expect(oldOutputs(t, 1).map((f) => f.file)).toEqual(["src/b.ts"])
})
