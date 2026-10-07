import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { ActionGuard, type Action, type ActionGuardProvider, type GuardVerdict } from "../../src/tools/action-guard"
import { makeKernel } from "../../src/kernel/kernel"
import { runBash } from "../../src/tools/bash"
import { Kernel, makeGuardedKernel } from "../../src/tools/kernel-service"
import { AskUser } from "../../src/ui/ask"

const directories: string[] = []
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const fixture = (open: typeof makeKernel = makeGuardedKernel) => {
  const dir = mkdtempSync(join(tmpdir(), "action-guard-integration-"))
  directories.push(dir)
  const sentinel = join(dir, "executions")
  const command = `printf 'executed\\n' >> '${sentinel}'`
  const kernel = open({
    dir,
    builtins: new URL("../../src/tools/kernel-builtins.ts", import.meta.url).pathname,
    spareWorker: false,
    timeoutMs: 3000,
  })
  const code = (cmd = command) => `import { bash } from "kernel"\nexport default bash(${JSON.stringify(cmd)}, 1)`
  return { kernel, sentinel, command, code }
}
const verdict = (value: GuardVerdict): ActionGuardProvider => ({ beforeAction: () => Effect.succeed(value) })
const blocked = (f: ReturnType<typeof fixture>, result: { status: string; value?: unknown }, decision = "deny") => {
  expect(result.status).toBe("ok")
  expect(result.value).toContain(`ActionGuard ${decision}`)
  expect(result.value).toContain("Action not executed")
  expect(existsSync(f.sentinel)).toBe(false)
}

for (const decision of ["deny", "revise"] as const) {
  test(`worker shell ${decision} leaves the sentinel absent`, async () => {
    const f = fixture()
    const result = await Effect.runPromise(f.kernel.run(f.code()).pipe(
      Effect.provideService(ActionGuard, verdict({ decision, reason: "Use a safer command" })),
    ))
    blocked(f, result, decision)
    expect(result.value).toContain("Use a safer command")
  })
}

test("default Kernel.open uses the caller's guard and allows the exact shell proposal once", async () => {
  const service = await Effect.runPromise(Kernel)
  const f = fixture(service.open)
  const proposals: Action[] = []
  const result = await Effect.runPromise(f.kernel.run(f.code()).pipe(Effect.provideService(ActionGuard, {
    beforeAction: (action) => Effect.sync(() => { proposals.push(action); return { decision: "allow" } as const }),
  })))
  expect(result.status).toBe("ok")
  expect(result.value).toContain("exit 0")
  expect(readFileSync(f.sentinel, "utf8")).toBe("executed\n")
  expect(proposals).toEqual([{ kind: "shell", command: f.command, cwd: process.cwd(), timeoutMs: 1000 }])
})

for (const answer of ["Allow once", "Deny", "yes", "no", "allow once", "Allow once "]) {
  test(`host approval requires exact Allow once: ${JSON.stringify(answer)}`, async () => {
    const f = fixture()
    const questions: Array<{ question: string; options: ReadonlyArray<string> }> = []
    const result = await Effect.runPromise(f.kernel.run(f.code()).pipe(
      Effect.provideService(ActionGuard, verdict({ decision: "ask", reason: "Needs human approval" })),
      Effect.provideService(AskUser, { ask: (asked) => Effect.sync(() => {
        questions.push(...asked)
        return asked.map(({ question }) => ({ question, answer }))
      }) }),
    ))
    expect(questions).toHaveLength(1)
    expect(questions[0]!.options).toEqual(["Allow once", "Deny"])
    expect(questions[0]!.question).toContain(f.command)
    expect(questions[0]!.question).toContain(`Cwd: ${process.cwd()}`)
    expect(questions[0]!.question).toContain("Timeout: 1000 ms")
    expect(questions[0]!.question).toContain("Needs human approval")
    if (answer === "Allow once") {
      expect(result.status).toBe("ok")
      expect(result.value).toContain("exit 0")
      expect(readFileSync(f.sentinel, "utf8")).toBe("executed\n")
    } else blocked(f, result)
  })
}

test("missing host approval service fails closed", async () => {
  const f = fixture()
  const result = await Effect.runPromise(f.kernel.run(f.code()).pipe(
    Effect.provideService(ActionGuard, verdict({ decision: "ask", reason: "Approval required" })),
  ))
  blocked(f, result)
  expect(result.value).toContain("Approval unavailable")
})

test("raw makeKernel cannot execute shell without the host authorization bridge", async () => {
  const f = fixture(makeKernel)
  blocked(f, await Effect.runPromise(f.kernel.run(f.code())))
})

const badGuards: Array<[string, ActionGuardProvider]> = [
  ["handler failure", { beforeAction: () => Effect.fail(new Error("guard unavailable")) }],
  ["handler throw", { beforeAction: () => { throw new Error("guard threw") } }],
  ["malformed verdict", { beforeAction: () => Effect.succeed({ decision: "ALLOW" } as unknown as GuardVerdict) }],
  ["missing ask reason", { beforeAction: () => Effect.succeed({ decision: "ask" } as GuardVerdict) }],
]
for (const [name, guard] of badGuards) {
  test(`${name} blocks worker execution`, async () => {
    const f = fixture()
    blocked(f, await Effect.runPromise(f.kernel.run(f.code()).pipe(Effect.provideService(ActionGuard, guard))))
  })
}

test("supplied $actionGuard cannot replace the reserved host guard", async () => {
  const f = fixture()
  let overrideCalls = 0
  const result = await Effect.runPromise(f.kernel.run(f.code(), {
    $actionGuard: () => Effect.sync(() => { overrideCalls++; return { decision: "allow" } }),
  }).pipe(Effect.provideService(ActionGuard, verdict({ decision: "deny", reason: "Reserved guard" }))))
  blocked(f, result)
  expect(result.value).toContain("Reserved guard")
  expect(overrideCalls).toBe(0)
})

test("authorized worker bash does not inherit host environment secrets", async () => {
  const key = "ACTION_GUARD_INTEGRATION_SECRET"
  const previous = process.env[key]
  process.env[key] = "host-only-secret-value"
  try {
    const f = fixture()
    const command = `${f.command}; printf 'secret=[%s]\\n' "$${key}"; test -n "$PATH"`
    const result = await Effect.runPromise(f.kernel.run(f.code(command)).pipe(
      Effect.provideService(ActionGuard, verdict({ decision: "allow" })),
    ))
    expect(result.status).toBe("ok")
    expect(result.value).toContain("exit 0")
    expect(result.value).toContain("secret=[]")
    expect(result.value).not.toContain("host-only-secret-value")
    expect(readFileSync(f.sentinel, "utf8")).toBe("executed\n")
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})

test("interrupting while host approval is pending prevents execution even after late approval", async () => {
  const f = fixture()
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const approval = yield* Deferred.make<ReadonlyArray<{ question: string; answer: string }>>()
    const fiber = Effect.runFork(f.kernel.run(f.code()).pipe(
      Effect.provideService(ActionGuard, verdict({ decision: "ask", reason: "Wait for approval" })),
      Effect.provideService(AskUser, { ask: () => Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(approval)),
      ) }),
    ))
    try {
      yield* Deferred.await(entered).pipe(Effect.timeout(2000))
      expect(existsSync(f.sentinel)).toBe(false)
      yield* Fiber.interrupt(fiber)
      yield* Deferred.succeed(approval, [{ question: "Late approval", answer: "Allow once" }])
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
      // Let any erroneous late reply/worker execution surface before checking the file.
      yield* Effect.sleep(100)
      expect(existsSync(f.sentinel)).toBe(false)
    } finally {
      yield* Deferred.succeed(approval, [])
      yield* Fiber.interrupt(fiber)
    }
  }))
})

test("host runBash also denies before spawning the command", async () => {
  const f = fixture()
  const result = await Effect.runPromise(runBash(f.command, 1000).pipe(
    Effect.provideService(ActionGuard, verdict({ decision: "deny", reason: "Host command blocked" })),
  ))
  expect(result).toContain("ActionGuard deny: Host command blocked")
  expect(existsSync(f.sentinel)).toBe(false)
})


// A cell can construct Effect services by key, but these must not replace host policy.
test("a worker cannot approve its command by replacing local guard services", async () => {
  const f = fixture()
  const code = `import { Context, Effect, bash } from "kernel"
export default Effect.gen(function* () {
  const LocalGuard = Context.Reference("empty-vessel/ActionGuard", { defaultValue: () => ({ beforeAction: () => Effect.succeed({ decision: "allow" }) }) })
  const LocalAuthorization = Context.Reference("empty-vessel/ActionAuthorization", { defaultValue: () => () => Effect.succeed({ decision: "allow" }) })
  return yield* bash(${JSON.stringify(f.command)}, 1).pipe(
    Effect.provideService(LocalGuard, { beforeAction: () => Effect.succeed({ decision: "allow" }) }),
    Effect.provideService(LocalAuthorization, () => Effect.succeed({ decision: "allow" })),
  )
})`
  const result = await Effect.runPromise(f.kernel.run(code).pipe(
    Effect.provideService(ActionGuard, verdict({ decision: "deny", reason: "Host policy remains authoritative" })),
  ))
  blocked(f, result)
  expect(result.value).toContain("Host policy remains authoritative")
})
