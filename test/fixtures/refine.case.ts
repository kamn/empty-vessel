import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { Background } from "../../src/base/background"
import { Config } from "../../src/base/config"
import { EMPTY_VESSEL_HOME } from "../../src/base/home"
import { memoryOnStore } from "../../src/base/memory"
import { projectDir } from "../../src/base/project"
import { diskStore } from "../../src/base/store"
import { Usage } from "../../src/base/usage"
import { ReviewerLive } from "../../src/learning/reviewer"
import { refineCommand } from "../../src/loop/refine"
import { SystemOneFromConfig, SystemTwoFromConfig } from "../../src/plugins/index"
import { Ask, AskError } from "../../src/system-two/ask"
import { FakeFill } from "../../src/system-two/fill"
import { AskUser } from "../../src/ui/ask"

// Run only in a child whose EMPTY_VESSEL_HOME is a temporary folder with fake systems (test/loop/refine.test.ts).
const root = mkdtempSync(join(tmpdir(), "empty-vessel-refine-project-"))

// A session of this project with one turn, ended at `at`: a command that timed out, the user's flag, the answer.
const session = (id: string, goal: string, at: number) => {
  const dir = join(EMPTY_VESSEL_HOME, "sessions", id)
  mkdirSync(dir, { recursive: true })
  const lines = [{ role: "project", text: root, checks: projectDir(root), ts: at - 4 }, { role: "user", text: goal, ts: at - 3 },
    { role: "command", text: "kernel", args: { code: "export default bash('bun run release')" }, output: "exit 137 (timed out after 30s and was stopped…)", ts: at - 2 },
    { role: "flag", text: "it should have used Node 24", running: true, activity: "", ts: at - 1 }, { role: "assistant", text: `done: ${goal}`, ts: at }]
  writeFileSync(join(dir, "main.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
}

// System Two's model, faked: the findings (a fix for empty-vessel, a project note and an agent note), and adoption's tools (one
// whose cell doesn't compile).
const inputs: Array<string> = []
const FakeAsk = Layer.succeed(Ask, {
  ask: (instructions, schema, input) => Effect.gen(function* () {
    inputs.push(input)
    const findings = { summary: "One slow release run.", fixInEmptyVessel: [{ finding: "It reran a timed-out command.", where: "session …01-a, turn 1" }],
      notes: [{ text: "Release scripts need Node 24", scope: "project", why: "the wrong Node" }, { text: "The user wants plain words", scope: "agent", why: "said so" }] }
    const adoption = { tools: [], proposals: [{ name: "brokenTool", for: "systemTwo", description: "d", example: "brokenTool()", parameters: [], code: "export const brokenTool = (: =>", why: "" }] }
    const value = yield* Schema.decodeUnknownEffect(schema)(instructions.includes("fixInEmptyVessel") ? findings : adoption)
    return { value, tokens: { input: 100, output: 10 } }
  }).pipe(Effect.mapError((e) => new AskError({ message: String(e) }))),
})

// The user's answer to "Keep which?", one per refine that asks.
const answers: Array<string> = []
const asked: Array<string> = []
const FakeUser = Layer.succeed(AskUser, { ask: (qs) => Effect.sync(() => { asked.push(qs[0]!.question); return [{ question: qs[0]!.question, answer: answers.shift() ?? "None" }] }) })

const run = (args: string) =>
  Effect.runPromise(refineCommand(args, root).pipe(
    Effect.provide([SystemOneFromConfig, SystemTwoFromConfig, FakeFill, ReviewerLive.pipe(Layer.provide(FakeAsk)), Background.layer, FakeUser, Usage.layer, memoryOnStore(root).pipe(Layer.provideMerge(diskStore()))]), // this project's memory (the plugin's is the cwd's)
    Effect.provide(Config.layer),
  )) as Promise<string>

test("refine: flags first, signals, three kinds of proposal; notes and tools kept only with the user's OK; undo; since the last", async () => {
  const before = Date.now() - 10_000
  session("01-a", "first request", before)
  session("01-b", "second request", before + 1)

  // The user keeps the project note only (1 of: 1 project note, 2 agent note, 3 tool).
  answers.push("1")
  const first = await run("")
  expect(first).toContain("refine 1: 2 turns in 2 sessions")
  expect(first.indexOf("flag (session …01-a")).toBeLessThan(first.indexOf("timeout (session …01-a"))
  expect(first).toContain("Fix in empty-vessel:\n  - It reran a timed-out command.")
  expect(asked.at(-1)).toContain("1. note (project): Release scripts need Node 24")
  expect(asked.at(-1)).toContain("3. tool for System Two: brokenTool")
  expect(inputs.at(-1)).toContain("second request")
  expect(inputs.join("\n")).toContain("it should have used Node 24") // the flag reached the model
  const learned = join(projectDir(root), "learned.md")
  expect(readFileSync(learned, "utf8")).toContain("- Release scripts need Node 24")
  expect(existsSync(join(EMPTY_VESSEL_HOME, "agents/memory.md")) ? readFileSync(join(EMPTY_VESSEL_HOME, "agents/memory.md"), "utf8") : "").not.toContain("plain words")

  // The log: what it found, the kept note, the two not chosen.
  const log = await run("log")
  expect(log).toContain("fix in empty-vessel: It reran a timed-out command.")
  expect(log).toContain("1.1   note  ✓ Release scripts need Node 24")
  expect(log).toContain("1.2   note  ✗ The user wants plain words  (not chosen)")
  expect(log).toMatch(/1\.3 +tool +✗ brokenTool .*not chosen/)

  // Undo the note; twice is refused; an edit not applied has nothing to undo.
  expect(await run("undo 1.1")).toContain("undid 1.1")
  expect(readFileSync(learned, "utf8")).not.toContain("Node 24")
  expect(await run("undo 1.1")).toContain("already undone")
  expect(await run("undo 1.2")).toContain("wasn't applied")

  // The next refine looks only at what ended since; --yes keeps everything without asking (the tool is still refused by promote).
  expect(await run("")).toContain("nothing new to refine from")
  session("01-c", "third request", Date.now() + 1000)
  const questions = asked.length
  const second = await run("--yes")
  expect(second).toContain("refine 2: 1 turns in 1 sessions")
  expect(asked.length).toBe(questions) // not asked
  expect(readFileSync(join(EMPTY_VESSEL_HOME, "agents/memory.md"), "utf8")).toContain("- The user wants plain words")
  expect(second).toMatch(/2\.3 +tool +✗ brokenTool/)
  expect(inputs.slice(-2).join("\n")).not.toContain("first request")
})
