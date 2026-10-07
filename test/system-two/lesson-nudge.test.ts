import { expect, test } from "bun:test"
import { Effect } from "effect"
import { lessonIn } from "../../src/base/lessons"
import { callTool, newCallState } from "../../src/system-two/dispatch"
import type { Hooks } from "../../src/system-two/systemtwo"

// A kernel whose cells "run" a command: its output is whatever the test says that command gives.
const outputs: Record<string, string> = {
  "npm test": "exit 1\nrefusing to run: wrong mode",
  "APP_MODE=test npm test": "exit 0\nall tests pass",
  "ls": "exit 0\nsrc test.js",
  "npm run lint": "exit 1\nlint failed",
  "npm run lint -- --fix": "exit 0\nfixed",
}
const run = (hooks: Hooks, state = newCallState()) => (command: string) =>
  Effect.runPromise(callTool("kernel", { code: `export default bash(${JSON.stringify(command)})` }, hooks, state)).then((r) => ("output" in r ? r.output : r.answer))
const withMemory = (snapshot = ""): Hooks => ({ kernel: (args) => Effect.succeed(`cell 1: ok $1 (string) = ${JSON.stringify(outputs[JSON.parse(args.code!.slice(args.code!.indexOf("(") + 1, -1))]!)}`), remembered: () => Effect.succeed(snapshot) })

test("a command that failed, then passed with an env var set: the next result suggests saving it, once", async () => {
  const call = run(withMemory())
  expect(await call("npm test")).not.toContain("setup lesson")
  const passed = await call("APP_MODE=test npm test")
  expect(passed).toContain('That looks like a setup lesson (a command failed, then this one passed with APP_MODE=test): keep it now with memory.add("project"')
  expect(await call("APP_MODE=test npm test")).not.toContain("setup lesson") // once per lesson
})

test("no nudge: an unrelated pass, a fix without an env var, a lesson already remembered, or no memory to save it in", async () => {
  const plain = run(withMemory())
  await plain("npm test")
  expect(await plain("ls")).not.toContain("setup lesson")

  const lint = run(withMemory())
  await lint("npm run lint")
  expect(await lint("npm run lint -- --fix")).not.toContain("setup lesson")

  const known = run(withMemory("About this project:\n- tests need APP_MODE=test"))
  await known("npm test")
  expect(await known("APP_MODE=test npm test")).not.toContain("setup lesson")

  const { remembered: _, ...noMemory } = withMemory()
  const none = run(noMemory)
  await none("npm test")
  expect(await none("APP_MODE=test npm test")).not.toContain("setup lesson")
})

test("lessonIn: only assignments the failed commands didn't have, and only on a pass", () => {
  expect(lessonIn(["npm run release"], "PATH=$HOME/.nvm/versions/node/v24/bin:$PATH npm run release", "exit 0")).toEqual(["PATH=$HOME/.nvm/versions/node/v24/bin:$PATH"])
  expect(lessonIn(["APP_MODE=test npm test"], "APP_MODE=test npm test", "exit 0")).toEqual([])
  expect(lessonIn(["npm test", 'bash("APP_MODE=test npm test")'], "APP_MODE=test npm test", "exit 0")).toEqual(["APP_MODE=test"]) // failing again with it (another bug) doesn't hide it
  expect(lessonIn(["npm run lint"], "APP_MODE=test npm test", "exit 0")).toEqual([]) // another command failed: not this lesson
  expect(lessonIn(["npm test"], "APP_MODE=test npm test", "exit 1")).toEqual([])
  expect(lessonIn([], "APP_MODE=test npm test", "exit 0")).toEqual([])
})

// Often the lesson is in the finishing check (npm test failed; the check sets APP_MODE=test and passes): the run doesn't
// end on that check yet, so System Two can keep the lesson, then answer.
test("a finishing check that passes with a new setup lesson doesn't end the run: it suggests saving it first", async () => {
  const state = newCallState()
  const hooks: Hooks = { remembered: () => Effect.succeed(""), handoff: (args) => Effect.succeed(args.command === "npm test" ? { output: "System One judged this broken.\nexit 1" } : { answer: "Fixed.", done: true }) }
  const check = (command: string) => Effect.runPromise(callTool("yield_to_system_one", { command, finishes: true, success: "Fixed." }, hooks, state))
  await check("npm test")
  const passed = await check("APP_MODE=test npm test")
  expect("output" in passed && passed.output).toContain("passed, and the task is done")
  expect("output" in passed && passed.output).toContain("setup lesson")
  expect(await check("APP_MODE=test npm test")).toMatchObject({ answer: "Fixed.", done: true }) // no new lesson: it ends
})
