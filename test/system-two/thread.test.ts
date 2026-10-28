import { expect, test } from "bun:test"
import { compressCell, dropOldReasoning, lastTurnStart, oldCells, oldFiles, reopenIndex, stubFile, SUMMARY_START } from "../../src/system-two/thread"

const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] })
const call = (id: string, name: string, args: object) => ({ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) })
const output = (id: string, text: string) => ({ type: "function_call_output", call_id: id, output: text })
const big = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`).join("\n")
const cell = (id: string, code: string, summary?: string) => call(id, "kernel", summary === undefined ? { code } : { summary, code })

const thread = (): Array<unknown> => [
  user("fix the cart"), cell("a", "export default read('src/cart.ts')", "Read cart"), output("a", big(40)),
  cell("b", "export default bash('ls')", "List files"), output("b", "a.ts"),
  call("q", "ask_user", { question: "which cart?" }), output("q", big(40)),
  user("now the money"), cell("c", "export default read('src/money.ts')", "Read money"), output("c", big(40)),
]

test("lastTurnStart: the last user message", () => {
  expect(lastTurnStart(thread())).toBe(7)
  expect(lastTurnStart([])).toBe(0)
})

test("lastTurnStart: messages the loop adds mid-run (steering, a jobs reminder, images, a stop note) don't start a turn", () => {
  const t: Array<unknown> = [user("fix the cart"), cell("a", "x", "Read cart"), output("a", big(40)), user("[The user, while you work: also tax]"),
    user("The images the tool calls above returned:"), user("Before you finish: these sub-agent jobs haven't been collected:\nj1"), user('(The user stopped your work on "x" partway. Files may already have been changed.)')]
  expect(lastTurnStart(t)).toBe(0)
  expect(oldCells(t, lastTurnStart(t))).toEqual([]) // the run's own cells stay whole
})

test("oldCells: big kernel cells before the last turn, with their intent and a glimpse of the output", () => {
  const found = oldCells(thread(), 7)
  expect(found.map((c) => [c.call, c.output, c.intent])).toEqual([[1, 2, "Read cart"]]) // "ls" is too small, ask_user isn't a cell, c is in the last turn
  expect(found[0]!.glimpse.split("\n")).toEqual([...big(40).split("\n").slice(0, 4), "[… 32 lines …]", ...big(40).split("\n").slice(-4)])
})

test("oldCells: a cell without a summary is known by its code's first line, imports left out", () => {
  const t: Array<unknown> = [user("go"), cell("a", "import { bash } from 'kernel'\nexport default bash('make')"), output("a", big(40)), user("next")]
  expect(oldCells(t, 3)[0]!.intent).toBe("export default bash('make')")
})

test("compressCell: one line in the thread, source and output in the stash, call_id kept", () => {
  const t = thread(), stash = new Map<string, string>()
  const saved = compressCell(t, oldCells(t, 7)[0]!, "cart total ignores tax", stash)

  expect(saved).toBeGreaterThan(900)
  expect(t[1]).toEqual({ type: "function_call", call_id: "a", name: "kernel", arguments: JSON.stringify({ summary: "Read cart", code: '[compacted: more_output { id: "out1" }]' }) })
  expect(t[2]).toEqual({ type: "function_call_output", call_id: "a", output: "[cell out1 · Read cart · 40 lines · result: cart total ignores tax]" })
  expect(stash.get("out1")).toBe(`export default read('src/cart.ts')\n── result ──\n${big(40)}`)
})

test("compressCell: no result summary falls back to the output's first line", () => {
  const t = thread(), stash = new Map<string, string>()
  compressCell(t, oldCells(t, 7)[0]!, undefined, stash)
  expect((t[2] as { output: string }).output).toBe(`[cell out1 · Read cart · 40 lines · result: line 1 ${"x".repeat(20)}]`)
})

test("a compressed cell is never found or rewritten again, so its line stays byte-identical", () => {
  const t = thread(), stash = new Map<string, string>()
  compressCell(t, oldCells(t, 7)[0]!, "cart total ignores tax", stash)
  const once = JSON.stringify(t)
  expect(oldCells(t, 7)).toEqual([])
  expect(JSON.stringify(t)).toBe(once)
})

test("files gather put in an old user message are stubbed one by one; the last turn's are left alone", () => {
  const files = `<file path="src/a.ts">\n${big(40)}\n</file>\n\n<file path="src/b.ts">\n${big(30)}\n</file>`
  const t: Array<unknown> = [user(`Goal: x\n\n${files}`), user(`next\n\n<file path="src/c.ts">\n${big(40)}\n</file>`)]
  const found = oldFiles(t, 1)
  expect(found).toEqual([{ index: 0, file: "src/a.ts" }, { index: 0, file: "src/b.ts" }])

  const stash = new Map<string, string>()
  stubFile(t, found[0]!, stash)
  const text = (t[0] as { content: Array<{ text: string }> }).content[0]!.text
  expect(text).toContain('<file path="src/a.ts">\n[compacted: 40 lines. If you need it: more_output { id: "out1" }]')
  expect(text).toContain(big(30)) // b.ts untouched
  expect(stash.get("out1")).toBe(big(40))
  expect(oldFiles(t, 1).map((f) => f.file)).toEqual(["src/b.ts"])
})

test("dropOldReasoning: reasoning before the last turn goes, the last turn's stays", () => {
  const reasoning = (n: number) => ({ type: "reasoning", encrypted_content: `r${n}` })
  const t: Array<unknown> = [user("a"), reasoning(1), cell("a", "x", "X"), output("a", "ok"), user("b"), reasoning(2)]
  expect(dropOldReasoning(t, lastTurnStart(t))).toBe(1)
  expect(t).toEqual([user("a"), cell("a", "x", "X"), output("a", "ok"), user("b"), reasoning(2)])
})

test("nothing before the last turn: nothing found", () => {
  const t: Array<unknown> = [user("only"), cell("a", "x", "X"), output("a", big(40))]
  expect(oldCells(t, lastTurnStart(t))).toEqual([])
  expect(oldFiles(t, lastTurnStart(t))).toEqual([])
})

test("reopenIndex: compressed cells, stubbed files and an earlier summary's list; other '- outN' lines don't count", () => {
  const files: Array<unknown> = [user(`go\n\n<file path="src/a.ts">\n${big(40)}\n</file>`), user("next")]
  const stash = new Map<string, string>()
  stubFile(files, oldFiles(files, 1)[0]!, stash)
  const t: Array<unknown> = [
    user(`${SUMMARY_START}\n\nearlier work\n\nStill reopenable with more_output (newest first):\n- out2: Read cart`),
    files[0], call("t", "tell_user", {}), output("t", "- out9: not an id list"), cell("c", "x", "Read tax"), output("c", "[cell out3 · Read tax · 40 lines · result: ok]"),
  ]
  expect(reopenIndex(t)).toBe("\n\nStill reopenable with more_output (newest first):\n- out3: Read tax\n- out2: Read cart\n- out1: file src/a.ts")
})
