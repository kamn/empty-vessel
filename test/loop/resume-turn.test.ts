import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { CurrentSession, logEntries, makeSession, SESSIONS } from "../../src/base/session"
import { diskStore } from "../../src/base/store"
import { answerOf, freshSession, needsSystemTwo, resumeWork, unfinishedTurn } from "../../src/loop/resume"
import { newConversation } from "../../src/loop/turnkit"
import { newCallState } from "../../src/system-two/dispatch"
import { makeClaudeSystemTwo } from "../../src/plugins/claude/claude"
import { SystemTwo } from "../../src/system-two/systemtwo"

const folders: Array<string> = []
const temporary = (prefix = "empty-vessel-resume-turn-") => { const path = mkdtempSync(join(tmpdir(), prefix)); folders.push(path); return path }
afterAll(() => { for (const path of folders) rmSync(path, { recursive: true, force: true }) })
const line = (o: object) => JSON.stringify(o)
const file = (lines: ReadonlyArray<object>) => {
  const dir = temporary()
  writeFileSync(join(dir, "main.jsonl"), `${lines.map(line).join("\n")}\n`)
  return dir
}

test("unfinishedTurn: a message with no answer or stop after it; its finished calls, the call cut off and what that call had started", () => {
  const done = file([{ role: "user", text: "first" }, { role: "call", tool: "kernel", args: {}, output: "1" }, { role: "assistant", text: "one" }])
  expect(unfinishedTurn(done)).toBeUndefined()
  expect(unfinishedTurn(file([{ role: "user", text: "x" }, { role: "assistant", text: "(stopped)" }]))).toBeUndefined() // a stop ends it

  const dir = file([
    { role: "user", text: "first" }, { role: "assistant", text: "one" },
    { role: "user", text: "run the tests?", run: "r1" },
    { role: "call", text: "kernel: read", tool: "kernel", args: { code: "read" }, started: true },
    { role: "effect", text: "write a.ts", id: "e0", cell: 1, kernel: "/k" }, { role: "effect", text: "write a.ts", id: "e0", outcome: "ok" },
    { role: "call", text: "kernel: read", tool: "kernel", args: { code: "read" }, output: "read it" },
    { role: "call", text: "kernel: bash", tool: "kernel", args: { code: "bash('npm test')" }, started: true },
    { role: "effect", text: "bash npm test", id: "e1", cell: 2, kernel: "/k" },
  ])
  const u = unfinishedTurn(dir)!
  expect(u.input).toBe("run the tests?")
  expect(u.run).toBe("r1")
  expect(u.calls.map((c) => c.output)).toEqual(["read it"])
  expect(u.cut).toEqual({ tool: "kernel", args: { code: "bash('npm test')" }, effects: [{ id: "e1", text: "bash npm test" }] })
  expect(u.step).toEqual([])
  expect(needsSystemTwo(u)).toBe(true)

  // System One's step started an effect and no finished step followed; a turn with nothing done needs nothing told.
  const step = unfinishedTurn(file([{ role: "user", text: "go" }, { role: "effect", text: "bash ls", id: "s1", cell: 1, kernel: "/k1" }]))!
  expect(step.step.map((e) => e.text)).toEqual(["bash ls"])
  expect(needsSystemTwo(unfinishedTurn(file([{ role: "user", text: "go" }, { role: "effect", text: "bash ls", id: "s1" }, { role: "step", text: "x → ok: y" }]))!)).toBe(false)

  expect(answerOf(file([{ role: "user", text: "a", run: "r0" }, { role: "assistant", text: "A" }, { role: "user", text: "b", run: "r1" }, { role: "assistant", text: "B" }]), "r1")).toBe("B")
  expect(answerOf(dir, "r1")).toBeUndefined()
})

// The cut-off call settled in a session: run again or handed back, and what System Two is told.
const settle = (lines: ReadonlyArray<object>, kernel: () => string) => Effect.runPromise(Effect.gen(function* () {
  const session = yield* makeSession(SESSIONS)
  for (const l of lines) yield* session.record((l as { role: "user" }).role, (l as { text?: string }).text ?? "", l as Record<string, unknown>)
  const u = unfinishedTurn(session.dir)!
  const note = yield* resumeWork(u, { kernel: () => Effect.sync(kernel) }, newCallState(), 10_000).pipe(Effect.provideService(CurrentSession, session))
  return { note, entries: logEntries(readFileSync(join(session.dir, "main.jsonl"), "utf8")) }
}).pipe(Effect.provide(diskStore(temporary()))))

test("Covers AE1. A cell cut off after it started bash npm test is handed back as interrupted, listing it, and not run again", async () => {
  let ran = 0
  const { note, entries } = await settle([
    { role: "user", text: "fix it?" },
    { role: "call", text: "kernel: read", tool: "kernel", args: { code: "read" }, output: "the file" },
    { role: "call", text: "kernel: test", tool: "kernel", args: { code: "bash('npm test')" }, started: true },
    { role: "effect", text: "bash npm test", id: "e1", cell: 2, kernel: "/k" },
  ], () => `ran ${++ran}`)

  expect(ran).toBe(0)
  expect(note).toContain("the file") // the call that finished, as saved
  expect(note).toContain("interrupted")
  expect(note).toContain("bash npm test (may have run)")
  const handedBack = entries.filter((e) => e.role === "call").at(-1)!
  expect(handedBack).toMatchObject({ tool: "kernel", interrupted: true })
  expect(handedBack.output).toContain("bash npm test")
})

test("Covers AE2. A cell cut off before any effect runs again once, recorded as a call of its own", async () => {
  let ran = 0
  const { note, entries } = await settle([
    { role: "user", text: "what time is it?" },
    { role: "call", text: "kernel: now", tool: "kernel", args: { code: "now()" }, started: true },
  ], () => `ran ${++ran}`)

  expect(ran).toBe(1)
  expect(note).toContain("run again:\nran 1")
  const calls = entries.filter((e) => e.role === "call")
  expect(calls.map((c) => c.started === true ? "started" : c.output)).toEqual(["started", "started", "ran 1"])
  expect(calls.some((c) => c.interrupted)).toBe(false)
})

test("a question waiting for the user when the restart came is asked again; a check System One was running is handed back", async () => {
  const asked: Array<string> = []
  const { note } = await Effect.runPromise(Effect.gen(function* () {
    const session = yield* makeSession(SESSIONS)
    yield* session.record("user", "pick one?")
    yield* session.record("call", "ask_user", { tool: "ask_user", args: { questions: [{ question: "Which?", options: ["a", "b"] }] }, started: true })
    const hooks = { askUser: (args: { questions: ReadonlyArray<{ question: string }> }) => Effect.sync(() => { asked.push(args.questions[0]!.question); return "a" }) }
    return { note: yield* resumeWork(unfinishedTurn(session.dir)!, hooks, newCallState(), 10_000).pipe(Effect.provideService(CurrentSession, session)) }
  }).pipe(Effect.provide(diskStore(temporary()))))
  expect(asked).toEqual(["Which?"])
  expect(note).toContain("run again:\na")

  const check = await settle([{ role: "user", text: "done?" }, { role: "call", text: "yield_to_system_one", tool: "yield_to_system_one", args: { command: "bun test" }, started: true }], () => "no")
  expect(check.note).toContain("interrupted")
  expect(check.note).toContain("(nothing recorded)")
})

test("the calls System Two is told about stay within the budget, the latest kept", async () => {
  const calls = Array.from({ length: 5 }, (_, i) => ({ role: "call", text: `kernel: ${i}`, tool: "kernel", args: { code: `c${i}` }, output: `out${i} ${"x".repeat(300)}` }))
  const { note } = await Effect.runPromise(Effect.gen(function* () {
    const session = yield* makeSession(SESSIONS)
    yield* session.record("user", "long?")
    for (const c of calls) yield* session.record("call", c.text, c)
    return { note: yield* resumeWork(unfinishedTurn(session.dir)!, {}, newCallState(), 800) }
  }).pipe(Effect.provide(diskStore(temporary()))))
  expect(note).toContain("out4")
  expect(note).not.toContain("out0")
  expect(note).toContain("earlier calls not shown")
})

test("freshSession: a Claude thread gets a fresh-session marker and our record; another backend's thread is left as it is", () => {
  const dir = temporary()
  const codex = newConversation()
  codex.thread.push({ role: "user", content: [] })
  freshSession(codex, dir, 10_000)
  expect(codex.thread).toHaveLength(1)

  const claude = newConversation()
  claude.thread.push({ claudeSession: "old" })
  claude.history.push({ user: "what is 2+2?", answer: "4" })
  freshSession(claude, dir, 10_000)
  expect(claude.thread[1]).toEqual({ claudeFresh: true })
  expect(JSON.stringify(claude.thread[2])).toContain("User: what is 2+2?\\nAnswer: 4")
})

test("Claude backend resume starts a fresh session whose prompt carries our record and the earlier steps", async () => {
  const dir = temporary("empty-vessel-fake-claude-")
  const fake = join(dir, "claude"), args = join(dir, "args"), stdin = join(dir, "stdin")
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > ${args}\ncat > ${stdin}\necho '{"type":"result","subtype":"success","result":"resumed answer","session_id":"new"}'\n`)
  chmodSync(fake, 0o755)
  const previous = process.env.EMPTY_VESSEL_CLAUDE_BIN
  process.env.EMPTY_VESSEL_CLAUDE_BIN = fake

  try {
    const conversation = newConversation()
    conversation.thread.push({ claudeSession: "old" })
    conversation.history.push({ user: "earlier question", answer: "earlier answer" })
    freshSession(conversation, dir, 10_000)

    const reply = await Effect.runPromise(Effect.gen(function* () {
      return yield* (yield* SystemTwo).ask("(empty-vessel restarted … kernel: read → the file)\n\nGoal: go on", { thread: conversation.thread })
    }).pipe(Effect.provide(makeClaudeSystemTwo())))

    expect(reply.text).toBe("resumed answer")
    expect(readFileSync(args, "utf8")).not.toContain("--resume")
    const sent = readFileSync(stdin, "utf8")
    expect(sent).toContain("earlier question")
    expect(sent).toContain("kernel: read → the file")
    expect(conversation.thread.at(-1)).toEqual({ claudeSession: "new" })
  } finally {
    if (previous === undefined) delete process.env.EMPTY_VESSEL_CLAUDE_BIN
    else process.env.EMPTY_VESSEL_CLAUDE_BIN = previous
  }
})

// The plain prompt reopening a session (--continue) with a turn a restart cut short: it goes on, says so once, and
// System Two hears the cut-off cell was handed back (the fake System Two repeats its prompt).
const main = resolve(import.meta.dir, "../../src/main.ts")
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("EMPTY_VESSEL_")))

test("the plain prompt reopening a session with an unfinished turn resumes it, then takes the new message", () => {
  const home = temporary(), project = realpathSync(temporary())
  writeFileSync(join(home, "config.json"), JSON.stringify({ systemOne: { use: "fake" }, systemTwo: { use: "fake" }, testOptions: true, learnAfterTurn: false }))
  const id = "0190a000-0000-7000-8000-000000000001"
  const dir = join(home, SESSIONS, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "main.jsonl"), `${[
    { role: "project", text: project, seq: 0 },
    { role: "user", text: "run the tests?", seq: 1 },
    { role: "call", text: "kernel: test", tool: "kernel", args: { code: "bash('npm test')" }, started: true, seq: 2 },
    { role: "effect", text: "bash npm test", id: "e1", cell: 1, kernel: join(dir, "kernel"), seq: 3 },
  ].map(line).join("\n")}\n`)

  const child = Bun.spawnSync(["bun", main, "--continue", "-p", "and then?"], { cwd: project, env: { ...cleanEnv, EMPTY_VESSEL_HOME: home }, stdout: "pipe", stderr: "pipe", timeout: 30_000 })
  const out = child.stdout.toString()
  expect(child.exitCode).toBe(0)
  expect(out).toContain("interrupted")
  expect(out).toContain("bash npm test (may have run)")
  expect(out.split("Resumed after a restart").length).toBe(2) // one notice for the resumed turn

  const entries = logEntries(readFileSync(join(dir, "main.jsonl"), "utf8"))
  expect(entries.filter((e) => e.role === "restart").map((e) => e.text)).toEqual(["run the tests?"])
  expect(entries.filter((e) => e.role === "user").map((e) => e.text)).toEqual(["run the tests?", "and then?"])
  expect(entries.filter((e) => e.role === "assistant")).toHaveLength(2)
  expect(entries.some((e) => e.text === "(stopped)")).toBe(false)
}, 40_000)
