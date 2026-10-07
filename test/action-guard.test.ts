import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { ActionGuard, authorizeAction, combineActionGuards, withActionGuard, type Action, type ActionGuardProvider, type GuardVerdict } from "../src/tools/action-guard"
import { AskUser } from "../src/ui/ask"

const action: Action = { kind: "shell", command: "printf 'hello'\nprintf 'world'", cwd: "/tmp/project with spaces", timeoutMs: 1234 }
const provider = (verdict: GuardVerdict): ActionGuardProvider => ({ beforeAction: () => Effect.succeed(verdict) })
const supplied = (value: unknown): ActionGuardProvider => ({ beforeAction: () => Effect.succeed(value as GuardVerdict) })
const asking = provider({ decision: "ask", reason: "Confirm the entire command" })
const ui = (answer: string): AskUser["Service"] => ({
  ask: (questions) => Effect.succeed(questions.map(({ question }) => ({ question, answer }))),
})

const blocked = (guard: ActionGuardProvider, ask?: AskUser["Service"]) => Effect.gen(function* () {
  let executions = 0
  const guarded = withActionGuard(action, Effect.sync(() => { executions++; return "EXECUTED" })).pipe(Effect.provideService(ActionGuard, guard))
  const result = yield* (ask ? guarded.pipe(Effect.provideService(AskUser, ask)) : guarded)
  expect(executions).toBe(0)
  expect(result).toContain("not executed")
  return result
})

describe("ActionGuard", () => {
  test("default YOLO and explicit allow execute exactly once", async () => {
    for (const guard of [undefined, provider({ decision: "allow" })]) {
      let executions = 0
      const guarded = withActionGuard(action, Effect.sync(() => { executions++; return "output" }))
      expect(await Effect.runPromise(guard ? guarded.pipe(Effect.provideService(ActionGuard, guard)) : guarded)).toBe("output")
      expect(executions).toBe(1)
    }
  })

  test("authorization never executes an action itself", async () => {
    expect(await Effect.runPromise(authorizeAction(action))).toEqual({ decision: "allow" })
  })

  test("execution errors propagate without retry", async () => {
    const error = new Error("execution failed")
    let executions = 0
    const result = await Effect.runPromise(withActionGuard(action, Effect.suspend(() => {
      executions++
      return Effect.fail(error)
    })).pipe(Effect.flip))
    expect(result).toBe(error)
    expect(executions).toBe(1)
  })

  for (const decision of ["deny", "revise"] as const) {
    test(`${decision} blocks execution with the reason`, () => Effect.runPromise(Effect.gen(function* () {
      const result = yield* blocked(provider({ decision, reason: "Use a read-only command" }))
      expect(result).toContain(`ActionGuard ${decision}: Use a read-only command`)
      if (decision === "revise") expect(result).toContain("Revise the proposal")
    })))
  }

  test("ask shows full proposal and reason and approves only once", async () => {
    let prompts = 0
    let executions = 0
    const ask: AskUser["Service"] = { ask: (questions) => Effect.sync(() => {
      prompts++
      expect(questions).toHaveLength(1)
      expect(questions[0]!.question).toContain(action.command)
      expect(questions[0]!.question).toContain(action.cwd)
      expect(questions[0]!.question).toContain(`${action.timeoutMs} ms`)
      expect(questions[0]!.question).toContain("Confirm the entire command")
      expect(questions[0]!.options).toEqual(["Allow once", "Deny"])
      return [{ question: questions[0]!.question, answer: "Allow once" }]
    }) }
    const run = withActionGuard(action, Effect.sync(() => { executions++; return "approved" })).pipe(
      Effect.provideService(ActionGuard, asking), Effect.provideService(AskUser, ask),
    )
    expect(await Effect.runPromise(run)).toBe("approved")
    expect(await Effect.runPromise(run)).toBe("approved")
    expect(prompts).toBe(2)
    expect(executions).toBe(2)
  })

  for (const answer of ["Deny", "yes", "allow once", "Allow once ", " Allow once", "Allow once\n", ""]) {
    test(`ask rejects ${JSON.stringify(answer)}`, () => Effect.runPromise(blocked(asking, ui(answer))))
  }

  test("ask without UI denies", () => Effect.runPromise(Effect.gen(function* () {
    expect(yield* blocked(asking)).toContain("no UI")
  })))

  for (const [name, ask] of [
    ["empty answers", { ask: () => Effect.succeed([]) }],
    ["multiple answers", { ask: () => Effect.succeed([{ question: "", answer: "Allow once" }, { question: "", answer: "Allow once" }]) }],
    ["thrown error", { ask: () => { throw new Error("UI broke") } }],
    ["defect", { ask: () => Effect.die("UI broke") }],
    ["failure", { ask: () => Effect.fail("UI broke") } as unknown as AskUser["Service"]],
    ["malformed answers", { ask: () => Effect.succeed(null) } as unknown as AskUser["Service"]],
  ] as const) {
    test(`ask fails closed on ${name}`, () => Effect.runPromise(blocked(asking, ask)))
  }

  for (const value of [undefined, null, true, "allow", [], Object.assign([], { decision: "allow" }), {}, { decision: "approve" }, { decision: "deny" }, { decision: "ask", reason: 3 }, { decision: "revise", reason: "  " }]) {
    test(`invalid verdict ${JSON.stringify(value)} denies`, () => Effect.runPromise(blocked(supplied(value))))
  }

  for (const [name, guard] of [
    ["throw", { beforeAction: () => { throw new Error("broken") } }],
    ["failure", { beforeAction: () => Effect.fail("broken") }],
    ["defect", { beforeAction: () => Effect.die("broken") }],
    ["non-Effect", { beforeAction: () => ({ decision: "allow" }) } as unknown as ActionGuardProvider],
    ["throwing verdict getter", supplied({ get decision() { throw new Error("broken") } })],
  ] as const) {
    test(`${name} fails closed without execution`, () => Effect.runPromise(blocked(guard)))
  }

  test("handler timeout fails closed", () => Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const guard: ActionGuardProvider = { beforeAction: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) }
    const fiber = yield* Effect.forkChild(blocked(guard))
    yield* Deferred.await(entered)
    yield* TestClock.adjust(10_001)
    expect(yield* Fiber.join(fiber)).toContain("timed out")
  }).pipe(Effect.provide(TestClock.layer()))))

  test("approval timeout fails closed", () => Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const ask: AskUser["Service"] = { ask: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) }
    const fiber = yield* Effect.forkChild(blocked(asking, ask))
    yield* Deferred.await(entered)
    yield* TestClock.adjust(300_001)
    expect(yield* Fiber.join(fiber)).toContain("timed out")
  }).pipe(Effect.provide(TestClock.layer()))))

  test("handler receives a frozen copy, leaving the original mutable", async () => {
    const original = { ...action }
    const guard: ActionGuardProvider = { beforeAction: (proposal) => Effect.sync(() => {
      expect(proposal).not.toBe(original)
      expect(Object.isFrozen(proposal)).toBe(true)
      expect(Reflect.set(proposal, "command", "unsafe")).toBe(false)
      expect(proposal).toEqual(action)
      return { decision: "allow" }
    }) }
    expect(await Effect.runPromise(authorizeAction(original).pipe(Effect.provideService(ActionGuard, guard)))).toEqual({ decision: "allow" })
    expect(Object.isFrozen(original)).toBe(false)
    expect(original).toEqual(action)
  })
})

describe("combineActionGuards", () => {
  const decisions = ["allow", "ask", "revise", "deny"] as const

  for (const first of decisions) {
    for (const second of decisions) {
      test(`${first} + ${second} uses the strongest verdict without prompting`, async () => {
        const guards = [first, second].map((decision) => provider(decision === "allow" ? { decision } : { decision, reason: decision }))
        const result = await Effect.runPromise(combineActionGuards(guards).beforeAction(action))
        expect(result.decision).toBe(decisions[Math.max(decisions.indexOf(first), decisions.indexOf(second))]!)
      })
    }
  }

  test("empty composition allows", async () => {
    expect(await Effect.runPromise(combineActionGuards([]).beforeAction(action))).toEqual({ decision: "allow" })
  })

  test("ask waits for every check, then prompts once with all ask reasons", async () => {
    const order: string[] = []
    const guards = ["first", "second", "third"].map((reason): ActionGuardProvider => ({ beforeAction: (proposal) => Effect.sync(() => {
      expect(Object.isFrozen(proposal)).toBe(true)
      order.push(reason)
      return { decision: "ask", reason }
    }) }))
    const ask: AskUser["Service"] = { ask: (questions) => Effect.sync(() => {
      expect(order).toEqual(["first", "second", "third"])
      for (const reason of order) expect(questions[0]!.question).toContain(reason)
      order.push("prompt")
      return [{ question: questions[0]!.question, answer: "Allow once" }]
    }) }
    expect(await Effect.runPromise(authorizeAction(action).pipe(
      Effect.provideService(ActionGuard, combineActionGuards(guards)), Effect.provideService(AskUser, ask),
    ))).toEqual({ decision: "allow" })
    expect(order).toEqual(["first", "second", "third", "prompt"])
  })

  for (const guard of [provider({ decision: "deny", reason: "blocked" }), provider({ decision: "revise", reason: "change it" }), supplied(null), { beforeAction: () => Effect.fail("broken") }]) {
    test("a later blocking or invalid handler prevents approval and execution", () => Effect.runPromise(blocked(
      combineActionGuards([asking, guard]),
      { ask: () => { throw new Error("must not prompt") } },
    ).pipe(Effect.tap((text) => Effect.sync(() => expect(text).not.toContain("Authorization failed"))))))
  }

  test("deny may short circuit and composition snapshots the handler list", async () => {
    const guards: ActionGuardProvider[] = [provider({ decision: "deny", reason: "stop" }), { beforeAction: () => { throw new Error("must not run") } }]
    const combined = combineActionGuards(guards)
    guards.length = 0
    expect(await Effect.runPromise(combined.beforeAction(action))).toEqual({ decision: "deny", reason: "stop" })
  })
})
