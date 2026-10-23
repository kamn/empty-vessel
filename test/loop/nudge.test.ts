import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { Background } from "../../src/base/background"
import { Config, ConfigSchema } from "../../src/base/config"
import { Events } from "../../src/base/events"
import { memoryOnStore } from "../../src/base/memory"
import { makeSession } from "../../src/base/session"
import { diskStore } from "../../src/base/store"
import { Usage } from "../../src/base/usage"
import { makeSessionRunner } from "../../src/interaction"
import { curateMemory, Reviewer } from "../../src/learning/reviewer"
import { TurnReports } from "../../src/loop/endturn"
import { Timers } from "../../src/loop/jobs"
import { countTurn, learningSignals, NO_WINDOW, type TurnReport } from "../../src/loop/signals"
import { turn } from "../../src/loop/turn"
import { type Conversation, newConversation, type Needs } from "../../src/loop/turnkit"
import { FakeSystemOne, SystemOne } from "../../src/system-one/systemone"
import { FakeSystemTwo } from "../../src/system-two/systemtwo"
import { AskUser } from "../../src/ui/ask"

// Memory nudges in the plain TUI (KTD18): the real turn loop (the fake System One answers alone: echo, so every turn is
// Jev-only), the window kept in the home's nudge.json, and a fake Reviewer whose answers the test gives.
type Asked = { input: string; fields: ReadonlyArray<string> }
const world = (options: { config?: object; answers?: ReadonlyArray<object>; gate?: Deferred.Deferred<void>; started?: Deferred.Deferred<void>; origin?: string; reports?: Array<TurnReport>; memory?: string } = {}) => {
  const home = mkdtempSync(join(tmpdir(), "nudge-home-")), project = join(home, "project")
  mkdirSync(project)
  if (options.memory) { mkdirSync(join(home, "agents")); writeFileSync(join(home, "agents", "memory.md"), options.memory) }
  const config = Schema.decodeUnknownSync(ConfigSchema)({ testOptions: true, learnAfterTurn: false, systemTwo: { scopeCheck: false }, ...options.config })
  const asked: Array<Asked> = [], judged: Array<string> = []

  const reviewer = Reviewer.of({
    review: () => Effect.die("the per-turn reviewer isn't on"),
    ask: (_instructions, schema, input) => Effect.gen(function* () {
      asked.push({ input, fields: Object.keys((schema as unknown as { fields: object }).fields) })
      const answer = options.answers?.[asked.length - 1] ?? { memory: [] }
      if (options.started) yield* Deferred.succeed(options.started, undefined)
      if (options.gate) yield* Deferred.await(options.gate)
      return { value: yield* Schema.decodeUnknownEffect(schema)(answer).pipe(Effect.orDie), tokens: { input: 0, output: 0 } }
    }) as never,
  })
  const systemOne = Layer.effect(SystemOne, Effect.gen(function* () {
    const fake = yield* SystemOne
    return { ...fake, judge: (state: object, questions: Parameters<typeof fake.judge>[1]) => { judged.push(JSON.stringify(state)); return fake.judge(state, questions) } }
  })).pipe(Layer.provide(FakeSystemOne))

  const provide = <A, E>(effect: Effect.Effect<A, E, Needs | Background>) => effect.pipe(
    Effect.provideService(Config, config),
    Effect.provideService(Events, { emit: () => Effect.void }),
    Effect.provideService(AskUser, { ask: () => Effect.succeed([]) }),
    Effect.provideService(Reviewer, reviewer),
    options.origin ? Effect.provideService(Timers, { ...Timers.defaultValue(), origin: () => options.origin }) : (e) => e,
    options.reports ? Effect.provideService(TurnReports, { report: (r) => Effect.sync(() => { options.reports!.push(r) }) }) : (e) => e,
    Effect.provide(memoryOnStore(project, { agent: config.memory.agentChars, project: config.memory.projectChars }).pipe(Layer.provideMerge(diskStore(home)))),
    Effect.provide(Background.layer), Effect.provide(systemOne), Effect.provide(FakeSystemTwo), Effect.provide(Usage.layer),
    Effect.provideContext(Context.empty() as Context.Context<Needs>),
  )
  // As main.ts does: the turn, then its exchange into the history.
  const say = (conversation: Conversation, text: string) => Effect.gen(function* () {
    const session = yield* makeSession("sessions")
    const reply = yield* turn(session, text, 0, conversation)
    conversation.history.push({ user: text, answer: reply })
    return reply
  })
  const inProject = async <A>(f: () => Promise<A>) => {
    const cwd = process.cwd()
    process.chdir(project)
    try { return await f() } finally { process.chdir(cwd) }
  }
  const window = () => existsSync(join(home, "nudge.json")) ? JSON.parse(readFileSync(join(home, "nudge.json"), "utf8")) : undefined
  const remembered = () => existsSync(join(home, "agents", "memory.md")) ? readFileSync(join(home, "agents", "memory.md"), "utf8") : ""
  return { home, project, asked, judged, provide, say, inProject, window, remembered, done: () => rmSync(home, { recursive: true, force: true }) }
}
const turns = (n: number, corrected?: number) => Array.from({ length: n }, (_, i) => i === corrected ? `No, I meant the second file ${i}` : `note ${i}`)

test("AE7, plain TUI: ten Jev-only user turns with one correction; every reply comes first, then a review that may only change memory", async () => {
  const gate = Deferred.makeUnsafe<void>(), started = Deferred.makeUnsafe<void>()
  const w = world({ gate, started, answers: [{ memory: [{ op: "add", scope: "agent", old: null, text: "The user means the second file when unsure." }] }] })
  try {
    await w.inProject(() => Effect.runPromise(w.provide(Effect.gen(function* () {
      const conversation = newConversation()
      const replies: Array<string> = []
      for (const text of turns(10, 4)) replies.push(yield* w.say(conversation, text))

      // All ten replied, and the review, started after the tenth, still waits on its model: it runs in the background.
      expect(replies).toHaveLength(10)
      expect(replies.at(-1)).toBe("echo: note 9")
      yield* Deferred.await(started)
      expect(w.asked).toHaveLength(1)
      expect(w.asked[0]!.fields).toEqual(["memory"])
      expect(w.asked[0]!.input).toContain("corrected")
      expect(w.asked[0]!.input).toContain("No, I meant the second file 4")
      expect(w.remembered()).toBe("")

      yield* Deferred.succeed(gate, undefined)
      yield* (yield* Background).drain
    }))))
    expect(w.remembered()).toBe("- The user means the second file when unsure.\n")
    expect(w.window()).toEqual(NO_WINDOW)
    expect(w.judged).toHaveLength(9) // one System One question per user turn after the first (nothing to correct before it)
  } finally { w.done() }
})

test("ten turns with no learning signal start the window over without a review", async () => {
  const w = world()
  try {
    await w.inProject(() => Effect.runPromise(w.provide(Effect.gen(function* () {
      const conversation = newConversation()
      for (const text of turns(9)) yield* w.say(conversation, text)
      expect(w.window()).toEqual({ userTurns: 9, toolIterations: 0, signals: [] })
      yield* w.say(conversation, "note 9")
      yield* (yield* Background).drain
    }))))
    expect(w.asked).toEqual([])
    expect(w.window()).toEqual(NO_WINDOW)
  } finally { w.done() }
})

test("a new session (/new) doesn't reset the count: the window is the home's, not the conversation's", async () => {
  const w = world({ answers: [{ memory: [] }] })
  try {
    await w.inProject(() => Effect.runPromise(w.provide(Effect.gen(function* () {
      const first = newConversation()
      for (const text of turns(5, 2)) yield* w.say(first, text)
      const second = newConversation()
      for (const text of turns(5)) yield* w.say(second, text)
      yield* (yield* Background).drain
    }))))
    expect(w.asked).toHaveLength(1)
  } finally { w.done() }
})

test("turns no user started (a job's, a detached sub-agent's) don't count, and with nudges off nothing is counted or asked", async () => {
  for (const options of [{ origin: "cron" }, { config: { nudges: false } }]) {
    const w = world(options)
    try {
      await w.inProject(() => Effect.runPromise(w.provide(Effect.gen(function* () {
        const conversation = newConversation()
        for (const text of turns(10, 4)) yield* w.say(conversation, text)
        yield* (yield* Background).drain
      }))))
      expect(w.window()).toBeUndefined()
      expect(w.judged).toEqual([])
      expect(w.asked).toEqual([])
    } finally { w.done() }
  }
})

test("with the background agent, each user turn's report goes to its worker, not the home", async () => {
  const reports: Array<TurnReport> = []
  const w = world({ reports })
  try {
    await w.inProject(() => Effect.runPromise(w.provide(Effect.gen(function* () {
      const conversation = newConversation()
      for (const text of turns(2, 1)) yield* w.say(conversation, text)
    }))))
    expect(reports).toEqual([
      { userTurns: 1, toolIterations: 0, signals: [], corrected: false },
      { userTurns: 1, toolIterations: 0, signals: [], corrected: true },
    ])
    expect(w.window()).toBeUndefined()
  } finally { w.done() }
})

test("a review whose add goes over the cap gets the error back once, and merges instead", async () => {
  const w = world({
    config: { memory: { agentChars: 80 } },
    memory: "- rg is not installed.\n",
    answers: [
      { memory: [{ op: "add", scope: "agent", old: null, text: "fd and jq are missing on this machine too: use find and node instead." }] },
      { memory: [{ op: "replace", scope: "agent", old: "rg is not", text: "rg, fd and jq are not installed." }] },
    ],
  })
  try {
    const said = await w.inProject(() => Effect.runPromise(w.provide(curateMemory("the user corrected an earlier answer", [{ user: "shorter please", answer: "ok" }]))))
    expect(w.asked).toHaveLength(2)
    expect(w.asked[1]!.input).toContain("agent memory is full")
    expect(w.asked[1]!.input).toContain("rg is not installed.")
    expect(said).toEqual([
      expect.stringContaining("not changed (agent memory is full"),
      "replaced (agent): rg, fd and jq are not installed.",
    ])
    expect(w.remembered()).toBe("- rg, fd and jq are not installed.\n")
  } finally { w.done() }
})

test("a window closes at 10 user turns or 10 tool calls; only one with a learning signal gives a review", () => {
  const report = (over: Partial<TurnReport> = {}): TurnReport => ({ userTurns: 1, toolIterations: 0, signals: [], corrected: false, ...over })
  let window = NO_WINDOW
  for (let i = 0; i < 9; i++) window = countTurn(window, report()).window
  expect(window).toEqual({ userTurns: 9, toolIterations: 0, signals: [] })
  expect(countTurn(window, report())).toEqual({ window: NO_WINDOW })

  const busy = countTurn(countTurn(NO_WINDOW, report({ toolIterations: 6, signals: ["steer: the user redirected it mid-run: use bun"] })).window, report({ toolIterations: 4 }))
  expect(busy.window).toEqual(NO_WINDOW)
  expect(busy.review).toContain("steer: the user redirected it mid-run: use bun")
  expect(countTurn(window, report({ corrected: true })).review).toContain("the user corrected an earlier answer or approach")
})

test("a turn's learning signals are this turn's only: a steer, failed checks, a command that worked with an env var", () => {
  const lines = [
    { role: "user", text: "first", ts: 1 },
    { role: "steer", text: "old steer", ts: 2 },
    { role: "user", text: "second", ts: 3 },
    { role: "steer", text: "use bun", ts: 4 },
    { role: "check", text: "bun test", verdict: "failed", ts: 5 },
    { role: "check", text: "bun test", verdict: "failed", ts: 6 },
    { role: "command", text: "kernel", args: { code: "bash(\"bun test\")" }, output: "exit 1", ts: 7 },
    { role: "command", text: "kernel", args: { code: "bash(\"APP_MODE=test bun test\")" }, output: "exit 0", ts: 8 },
  ]
  const signals = learningSignals(lines)
  expect(signals).toEqual([
    "steer: the user redirected it mid-run: use bun",
    "checks: the check failed again: bun test",
    expect.stringMatching(/^env fix: failed: .*\n {2}then worked with APP_MODE=test/),
  ])
})

test("/memory in the shared runner (the TUI, channels, the agent's worker) lists memory without making a turn", async () => {
  const w = world({ memory: "- rg is not installed.\n" })
  try {
    const reply = await w.inProject(() => Effect.runPromise(w.provide(Effect.gen(function* () {
      const conversation = newConversation()
      const runner = yield* makeSessionRunner(yield* makeSession("sessions"), conversation, { events: { emit: () => Effect.void } })
      const { reply } = yield* runner.run("/memory")
      expect(conversation.history).toEqual([])
      return reply
    }).pipe(Effect.scoped))))
    expect(reply).toContain("agent (23 of 2400 characters)")
    expect(reply).toContain("1. rg is not installed.")
  } finally { w.done() }
})
