import { expect, test } from "bun:test"
import { Effect } from "effect"
import { type CompactOptions, type Model, type ModelRequest, SystemTwo } from "empty-vessel"
import { systemTwoFromModel } from "../../src/system-two/loop"
import { answer, newRun } from "../../src/system-two/relay"
import type { Hooks } from "../../src/system-two/systemtwo"

const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] })
const cell = (id: string, summary: string) => ({ type: "function_call", call_id: id, name: "kernel", arguments: JSON.stringify({ summary, code: `export default read('${id}.ts')` }) })
const output = (id: string, text: string) => ({ type: "function_call_output", call_id: id, output: text })
const big = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`).join("\n")

// Two old cells (~1k characters each) and old reasoning before the last turn; the last turn has a cell of its own.
const thread = (): Array<unknown> => [
  user("fix the cart"), { type: "reasoning", encrypted_content: "r".repeat(4000) }, cell("a", "Read cart"), output("a", big(40)), cell("b", "Read tax"), output("b", big(40)),
  user("now the money"), cell("c", "Read money"), output("c", big(40)),
]
const lastTurn = () => JSON.stringify(thread().slice(6))

// A fake model that answers every request with `text` (or fails), and keeps what it was asked.
const fake = (text: string, fail = false) => {
  const asked: Array<ModelRequest> = []
  const model: Model = {
    name: "fake",
    complete: (r) => fail ? Effect.fail(new Error("down")) as never : Effect.sync(() => { asked.push(r); return { text, calls: [], keep: [], thinking: "", searches: [], usage: { input: 900, cached: 0, output: 40, thinking: 0 } } }),
  }
  return { model, asked }
}

const compact = (model: Model, t: Array<unknown>, options: Partial<CompactOptions> & Pick<CompactOptions, "size" | "target">) =>
  Effect.runPromise(SystemTwo.use((s) => s.compact(t, { summarize: (cells) => Effect.succeed(cells.map((c) => `found ${c.intent}`)), stash: new Map(), ...options })).pipe(Effect.provide(systemTwoFromModel(model, 5))))

test("tier 1 is enough: old cells become lines, old reasoning goes, no summary request", async () => {
  const { model, asked } = fake("unused"), t = thread()
  const done = await compact(model, t, { size: 1000, target: 600 }) // cells save ~2×(1k chars)/4 ≈ 450

  expect(asked).toEqual([])
  expect(done).toMatchObject({ compressed: 2, stubbed: 0, reasoning: 1, summarized: 0 })
  expect(done.after).toBeLessThanOrEqual(600)
  expect(t.map((i: any) => i.output).filter(Boolean).slice(0, 2)).toEqual(["[cell out1 · Read cart · 40 lines · result: found Read cart]", "[cell out2 · Read tax · 40 lines · result: found Read tax]"])
  expect(JSON.stringify(t.slice(-3))).toBe(lastTurn())
})

test("tier 1 isn't enough: one summary request, and the summary ends with what can still be reopened", async () => {
  const { model, asked } = fake("## Goal\nfix the cart"), t = thread()
  const done = await compact(model, t, { size: 1000, target: 100 })

  expect(asked).toHaveLength(1)
  expect(done).toMatchObject({ compressed: 2, summarized: 5, tokens: { input: 900, output: 40 } })
  expect(t).toHaveLength(4)
  expect((t[0] as any).content[0].text).toEndWith("## Goal\nfix the cart\n\nStill reopenable with more_output (newest first):\n- out2: Read tax\n- out1: Read cart")
  expect(JSON.stringify(t.slice(1))).toBe(lastTurn())
})

test("the reopen list keeps the newest 100", async () => {
  const many: Array<unknown> = [user("go"), ...Array.from({ length: 120 }, (_, i) => [cell(`c${i}`, `Cell ${i}`), output(`c${i}`, big(40))]).flat(), user("next")]
  await compact(fake("summary").model, many, { size: 100_000, target: 10 })
  const text: string = (many[0] as any).content[0].text
  expect(text.match(/^- out\d+:/gm)).toHaveLength(100)
  expect(text).toContain("- out120: Cell 119")
  expect(text).not.toContain("- out20: Cell 19\n")
})

test("summarize fails: every cell still gets a line from its first output line, and the turn goes on", async () => {
  const t = thread()
  await compact(fake("unused").model, t, { size: 1000, target: 600, summarize: () => Effect.succeed([]) })
  expect((t[2] as any).output).toBe(`[cell out1 · Read cart · 40 lines · result: line 1 ${"x".repeat(20)}]`)
})

test("more_output on a compacted cell's id gives back its code and full output; an unknown id says so", async () => {
  const t = thread(), stash = new Map<string, string>()
  await compact(fake("unused").model, t, { size: 1000, target: 600, stash })
  const hooks: Hooks = { stash }
  const more = (id: string) => Effect.runPromise(answer("more_output", { id }, hooks, newRun(stash)))

  expect(await more("out1")).toBe(`export default read('a.ts')\n── result ──\n${big(40)}`)
  expect(await more("out9")).toContain("no shortened output with id out9")
})

test("the summary request fails: tier 1's result is kept", async () => {
  const t = thread()
  const done = await compact(fake("", true).model, t, { size: 1000, target: 100 })
  expect(done).toMatchObject({ compressed: 2, summarized: 0 })
  expect(t).toHaveLength(8) // reasoning dropped, nothing summarized
})
