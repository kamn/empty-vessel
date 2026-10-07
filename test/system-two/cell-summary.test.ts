import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { Events } from "../../src/base/events"
import { makeKernel } from "../../src/kernel/kernel"
import { callTool, newCallState, shownAs, SYSTEM_TWO_TOOLS } from "../../src/system-two/dispatch"
import { KernelArgs, type Hooks } from "../../src/system-two/systemtwo"
import { init, Message, update } from "../../src/ui/tui/app"
import { printLine } from "../../src/ui/tui/view"

const code = "export default 42"

test("cell summaries accept 1–6 words and reject empty, multiline or oversized titles", () => {
  for (const summary of ["Inspect", "Read the notebook cell rendering code"]) {
    expect(Schema.decodeUnknownSync(KernelArgs)({ code, summary }).summary).toBe(summary)
  }
  for (const summary of ["", "one two three four five six seven", "Read\nfile", "Read file\n", "x".repeat(97)]) {
    expect(() => Schema.decodeUnknownSync(KernelArgs)({ code, summary })).toThrow()
  }
  expect(Schema.decodeUnknownSync(KernelArgs)({ code }).summary).toBeUndefined()
  expect(JSON.stringify(SYSTEM_TWO_TOOLS.find((tool) => tool.name === "kernel"))).toContain("summary")
})

test("summary reaches the tool hook, session callback, event, and rendered cell", async () => {
  const args = { code, summary: "Inspect notebook renderer" }
  const events: Array<Parameters<ReturnType<typeof Events.defaultValue>["emit"]>[0]> = []
  const recorded: Array<unknown> = []
  let received: unknown
  const hooks: Hooks = {
    kernel: (value) => Effect.sync(() => { received = value; return "cell 1: ok\n$1 (number) = 42" }),
    onCommand: (value) => Effect.sync(() => { recorded.push(value) }),
  }
  await Effect.runPromise(callTool("kernel", args, hooks, newCallState()).pipe(
    Effect.provideService(Events, { emit: (event) => Effect.sync(() => { events.push(event) }) }),
  ))
  expect(received).toEqual(args)
  expect(recorded[0]).toMatchObject({ tool: "kernel", args })
  const event = events.find((event) => event.kind === "system-two")!
  expect(event.summary).toBe(args.summary)
  const model = update(init("status"), Message.GotEvent(event)).model
  const output = printLine(model.printed[0]!).join("\n")
  expect(output).toContain("kernel · TypeScript · Inspect notebook renderer")
  expect(output).not.toContain("CODE")
  expect(shownAs("kernel", args)).toBe("kernel: Inspect notebook renderer")
  expect(shownAs("kernel", { code })).toBe(`kernel: ${code}`)
})

test("invalid summaries never run a cell", async () => {
  let ran = false
  const hooks: Hooks = { kernel: () => Effect.sync(() => { ran = true; return "ran" }) }
  const result = await Effect.runPromise(callTool("kernel", { code, summary: "one two three four five six seven" }, hooks, newCallState()))
  expect(ran).toBe(false)
  expect(result).toHaveProperty("output")
})

test("intent titles persist separately from result summaries for code, text, and refused cells", async () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-cell-title-"))
  try {
    const kernel = makeKernel({ dir, spareWorker: false })
    const result = await Effect.runPromise(kernel.run(code, {}, "Compute sample value"))
    const text = await Effect.runPromise(kernel.text("draft", "hello", "Draft a greeting"))
    const refused = await Effect.runPromise(kernel.run("export default () => process.exit(3)", {}, "Exit the process"))
    expect(result.title).toBe("Compute sample value")
    expect(result.summary).toContain("42")
    expect(text.title).toBe("Draft a greeting")
    expect(refused.status).toBe("refused")
    expect(refused.title).toBe("Exit the process")
    expect(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).map((cell: { title: string }) => cell.title)).toEqual([result.title, text.title, refused.title])
    expect(makeKernel({ dir, spareWorker: false }).cells()[0]!.title).toBe(result.title)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
