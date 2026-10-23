import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { CurrentSession, type SessionHandle } from "../../src/base/session"
import type { CellResult, ToolSource } from "../../src/kernel/kernel"
import { makeSources } from "../../src/loop/sources"
import { noAbsoluteRm } from "../../src/plugins/no-absolute-rm"
import { type Action, ActionGuard, authorizeAction, combineActionGuards } from "../../src/tools/action-guard"
import { makeGuardedKernel } from "../../src/tools/kernel-service"
import { AskUser } from "../../src/ui/ask"

// Desktop control (KTD26): every call to a source marked `ask` asks first. A fake source stands in for the MCP server;
// nothing touches the desktop.
const BUILTINS = resolve("src/tools/kernel-builtins.ts")

const desk = (ask: boolean) => {
  const calls: Array<{ tool: string; args: unknown }> = []
  const source: ToolSource = {
    name: "desk",
    ...(ask ? { ask: true } : {}),
    list: Effect.succeed([{ name: "click", description: "Click" }]),
    call: (tool, args) => Effect.sync(() => { calls.push({ tool, args }); return "clicked" }),
  }
  return { source, calls }
}

// One cell calling desk.click, with a UI answering `answer` (none: no UI, like a cron turn).
const run = async (ask: boolean, answer?: string, guard?: (typeof ActionGuard)["Service"]) => {
  const { source, calls } = desk(ask)
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-mcp-guard-"))
  const kernel = makeGuardedKernel({ dir, builtins: BUILTINS, spareWorker: false, timeoutMs: 20_000, sources: [source] })
  const effects: Array<string> = [], questions: Array<string> = []
  const session = { id: "s", key: "sessions/s", dir, record: (role: string, text: string) => Effect.sync(() => { if (role === "effect") effects.push(text) }) } as unknown as SessionHandle

  const cell = kernel.run(`import { desk } from "kernel"\nexport default desk.click({ x: 10, y: 20 })`).pipe(
    Effect.provideService(CurrentSession, session),
    Effect.provideService(ActionGuard, guard ?? ActionGuard.defaultValue()),
  )
  const ui = { ask: (qs: ReadonlyArray<{ question: string }>) => Effect.sync(() => qs.map(({ question }) => { questions.push(question); return { question, answer: answer! } })) }
  const r: CellResult = await Effect.runPromise(answer === undefined ? cell : cell.pipe(Effect.provideService(AskUser, ui)))

  return { r, calls, effects, questions }
}

test("an ask source's call waits for approval: allowed, it runs and is journaled; the question names the tool and args", async () => {
  const { r, calls, effects, questions } = await run(true, "Allow once")

  expect(r).toMatchObject({ status: "ok", value: "clicked" })
  expect(calls).toEqual([{ tool: "click", args: { x: 10, y: 20 } }])
  expect(questions).toHaveLength(1)
  expect(questions[0]).toContain("desk.click")
  expect(questions[0]).toContain(`"x": 10`)
  expect(questions[0]).not.toContain("Cwd:")
  expect(effects).toEqual([`desk.click {"x":10,"y":20}`])
}, 60_000)

test("denied: the call isn't made, the cell gets the refusal, nothing is journaled", async () => {
  const { r, calls, effects } = await run(true, "Deny")

  expect(r.status).toBe("error")
  expect(r.summary).toContain("Approval rejected")
  expect(calls).toEqual([])
  expect(effects).toEqual([])
}, 60_000)

test("no UI (a cron or sub-agent turn): denied without asking", async () => {
  const { r, calls } = await run(true)

  expect(r.status).toBe("error")
  expect(r.summary).toContain("no UI")
  expect(calls).toEqual([])
}, 60_000)

test("a source without ask doesn't ask; a guard's deny still wins over an ask source's approval", async () => {
  const plain = await run(false, "Deny")
  expect(plain.r).toMatchObject({ status: "ok", value: "clicked" })
  expect(plain.questions).toEqual([])

  const denied = await run(true, "Allow once", { beforeAction: () => Effect.succeed({ decision: "deny", reason: "policy says no" }) })
  expect(denied.r.summary).toContain("policy says no")
  expect(denied.questions).toEqual([])
  expect(denied.calls).toEqual([])
}, 60_000)

test("shell-only providers allow mcp actions without crashing", async () => {
  const action: Action = { kind: "mcp", source: "desk", tool: "click", args: { x: 1 } }
  const guard = await Effect.runPromise(Effect.flatMap(noAbsoluteRm.provides.actionGuard, (layer) => ActionGuard.pipe(Effect.provide(layer))))

  expect(await Effect.runPromise(combineActionGuards([guard]).beforeAction(action))).toEqual({ decision: "allow" })
  expect(await Effect.runPromise(authorizeAction(action).pipe(Effect.provideService(ActionGuard, guard)))).toEqual({ decision: "allow" })
})

test("makeSources carries the config's ask flag", () => {
  const [asking, plain] = makeSources({ desk: { command: "true", ask: true }, other: { command: "true" } } as never)
  expect(asking!.ask).toBe(true)
  expect(plain!.ask).toBeUndefined()
})
