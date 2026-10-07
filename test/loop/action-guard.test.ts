import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Schema } from "effect"
import { ConfigSchema } from "../../src/base/config"
import { scopeFor } from "../../src/kernel/kernel"
import { loadChecks, vetCheck } from "../../src/learning/checks"
import { makeHandoff } from "../../src/loop/handoff"
import { makeHost, makeKernelHook } from "../../src/loop/kernel"
import { BUILTINS, saveLibrary } from "../../src/loop/library"
import { libraryStep } from "../../src/loop/steps"
import { newConversation, newTurnState, type Ctx, type Needs } from "../../src/loop/turnkit"
import { ActionGuard, type Action, type ActionGuardProvider } from "../../src/tools/action-guard"
import { runBash } from "../../src/tools/bash"
import { AskUser } from "../../src/ui/ask"

// Only model/session edges are faked: Kernel, its worker, authorization, and bash are real.
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-loop-guard-"))
  const records: Array<{ role: string; text: string; data: unknown }> = []
  const ctx = {
    session: { id: "guard-test", dir, record: (role: string, text: string, data: unknown) => Effect.sync(() => { records.push({ role, text, data }) }) },
    config: Schema.decodeUnknownSync(ConfigSchema)({ kernel: { tools: { sources: false } } }),
    conversation: newConversation(), input: "run the check", depth: 0,
    usage: { add: () => Effect.void },
  } as unknown as Ctx
  const marker = join(dir, "executed")
  const checkFile = join(dir, "check.ts")
  writeFileSync(checkFile, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed")`)
  const command = `bun '${checkFile}'`
  const actions: Action[] = []
  const guard: ActionGuardProvider = { beforeAction: (action) => Effect.sync(() => {
    actions.push(action)
    return { decision: "deny", reason: "loop policy" }
  }) }
  return { dir, ctx, records, marker, command, actions, guard }
}
const shellCell = (command: string) => `import { bash } from "kernel"\nexport default bash(${JSON.stringify(command)}, 7)`
const captured = (guard: ActionGuardProvider, ask?: AskUser["Service"]) => {
  const services = Context.make(ActionGuard, guard)
  return (ask ? Context.add(services, AskUser, ask) : services) as unknown as Context.Context<Needs>
}

test("System Two makeKernelHook retains captured policy outside the creating Effect context", async () => {
  const s = setup()
  const hook = await Effect.runPromise(Effect.gen(function* () {
    return makeKernelHook(s.ctx, yield* Effect.context<Needs>())
  }).pipe(Effect.provideContext(captured(s.guard))))
  // Fresh runtime: there is deliberately no ActionGuard service at invocation time.
  const output = await Effect.runPromise(hook({ code: shellCell(s.command) }))
  expect(output).toContain("ActionGuard deny: loop policy")
  expect(s.actions).toEqual([{ kind: "shell", command: s.command, cwd: process.cwd(), timeoutMs: 7000 }])
  expect(existsSync(s.marker)).toBe(false)
}, 30_000)

test("System Two callback retains AskUser and requests approval again for each execution", async () => {
  const s = setup()
  const prompts: string[] = []
  const guard: ActionGuardProvider = { beforeAction: (action) => Effect.sync(() => {
    s.actions.push(action)
    return { decision: "ask", reason: "confirm this command" }
  }) }
  const ask: AskUser["Service"] = { ask: (questions) => Effect.sync(() => {
    prompts.push(questions[0]!.question)
    expect(questions[0]!.options).toEqual(["Allow once", "Deny"])
    return [{ question: questions[0]!.question, answer: prompts.length === 1 ? "Deny" : "Allow once" }]
  }) }
  const hook = makeKernelHook(s.ctx, captured(guard, ask))
  expect(await Effect.runPromise(hook({ code: shellCell(s.command) }))).toContain("Approval rejected")
  expect(existsSync(s.marker)).toBe(false)
  expect(await Effect.runPromise(hook({ code: shellCell(s.command) }))).toContain("exit 0")
  expect(existsSync(s.marker)).toBe(true)
  expect(s.actions).toHaveLength(2)
  expect(prompts).toHaveLength(2)
  for (const prompt of prompts) {
    expect(prompt).toContain(s.command)
    expect(prompt).toContain(process.cwd())
    expect(prompt).toContain("7000 ms")
    expect(prompt).toContain("confirm this command")
  }
}, 30_000)

test("System One libraryStep shell reaches the host policy through its real worker", async () => {
  const s = setup()
  const file = join(s.dir, "guardedCheck.ts")
  writeFileSync(join(s.dir, "scope.ts"), scopeFor([], BUILTINS))
  writeFileSync(file, `import { bash } from "./scope.ts"\nexport const guardedCheck = (_request: string) => bash(${JSON.stringify(s.command)}, 7)\n`)
  saveLibrary(s.dir, [{ name: "guardedCheck", description: "Run a check", file, from: "guard-test" }])
  const result = await Effect.runPromise(libraryStep("guardedCheck", s.dir)(s.ctx, newTurnState()).pipe(Effect.provideContext(captured(s.guard))))
  expect(result.reply).toContain("ActionGuard deny: loop policy")
  expect(s.actions).toEqual([{ kind: "shell", command: s.command, cwd: process.cwd(), timeoutMs: 7000 }])
  expect(existsSync(s.marker)).toBe(false)
}, 30_000)

test("spawn host preserves policy across the detached child job runtime", async () => {
  const s = setup()
  // Exercise the real spawn/job boundary without a full recursive model-driven turn.
  const ctx = { ...s.ctx, spawn: () => runBash(s.command, 7000) } as Ctx
  const host = makeHost(ctx, captured(s.guard))
  const id = await Effect.runPromise(host.spawn!({ task: "child shell" })) as string
  try {
    const jobs = await Effect.runPromise(ctx.conversation.jobs.wait([id], 5))
    expect(jobs[id]?.status).toBe("done")
    const child = jobs[id]
    expect(child && "answer" in child ? child.answer : undefined).toContain("ActionGuard deny: loop policy")
    expect(s.actions).toEqual([{ kind: "shell", command: s.command, cwd: process.cwd(), timeoutMs: 7000 }])
    expect(existsSync(s.marker)).toBe(false)
    expect(ctx.conversation.jobs.pending()).toEqual([])
  } finally {
    await Effect.runPromise(ctx.conversation.jobs.cancel(id))
  }
})

for (const choice of ["passed", "escalate"]) {
  test(`yield_to_system_one cannot pass or save a denied command when System One says ${choice}`, async () => {
    const s = setup()
    const evidence: unknown[] = []
    const ctx = { ...s.ctx, systemOne: { choose: (input: unknown) => {
      evidence.push(input)
      return Effect.succeed({ choice, confidence: 1, tokens: { input: 0, output: 0 } })
    } } } as unknown as Ctx
    const state = newTurnState()
    const save = { name: `guard-${s.dir.split("/").at(-1)}`, description: "Guard regression check", template: s.command, args: {}, scope: "project" as const }
    // Ensure failure to save isn't merely a malformed save_as request.
    expect(vetCheck(save, s.command, process.cwd())).toBeUndefined()
    const before = await Effect.runPromise(loadChecks(process.cwd()))
    const reply = await Effect.runPromise(makeHandoff(ctx, state, [])({ command: s.command, finishes: true, success: "MUST NOT FINISH", save_as: save }).pipe(Effect.provideService(ActionGuard, s.guard)))
    expect(reply).toEqual({ output: expect.stringContaining("ActionGuard deny: loop policy") })
    expect(state.passed).toEqual([])
    expect(s.records).toContainEqual(expect.objectContaining({ role: "check", data: expect.objectContaining({ verdict: "failed" }) }))
    expect(JSON.stringify(evidence)).toContain("ActionGuard deny: loop policy")
    expect(s.actions).toEqual([{ kind: "shell", command: s.command, cwd: process.cwd(), timeoutMs: 120_000 }])
    expect(existsSync(s.marker)).toBe(false)
    expect(await Effect.runPromise(loadChecks(process.cwd()))).toEqual(before)
  })
}
