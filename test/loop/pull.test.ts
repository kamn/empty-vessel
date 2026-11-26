import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Schema } from "effect"
import { Config, ConfigSchema } from "../../src/base/config"
import { Events } from "../../src/base/events"
import { Memory, MemoryPull, notesPull, type PullCandidate, type PullUsage } from "../../src/base/memory"
import { makeSession } from "../../src/base/session"
import { diskStore } from "../../src/base/store"
import { Usage } from "../../src/base/usage"
import { pull } from "../../src/loop/pull"
import { turn } from "../../src/loop/turn"
import { type Ctx, newConversation, type Needs } from "../../src/loop/turnkit"
import { FakeSystemOne, type StepState, SystemOne } from "../../src/system-one/systemone"
import { FakeSystemTwo, type Hooks, SystemTwo } from "../../src/system-two/systemtwo"
import { AskUser } from "../../src/ui/ask"

type Capability = typeof MemoryPull extends Context.Reference<infer S> ? S : never
const fakeOne = Effect.runSync(Effect.gen(function* () { return yield* SystemOne }).pipe(Effect.provide(FakeSystemOne)))
const noMemory = { snapshot: Effect.succeed(""), add: () => Effect.void, replace: () => Effect.void, remove: () => Effect.void, entries: () => Effect.succeed([]), file: () => Effect.succeed("") }
const facts = (n: number, chars: number): Array<PullCandidate> => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, text: `${i}`.padEnd(chars, "x") }))

// The pull alone: a Ctx with just what it uses (System One and the usage tally).
const runPull = (candidates: ReadonlyArray<PullCandidate> | undefined, one: SystemOne["Service"] = fakeOne, limits?: { facts?: number; chars?: number }) =>
  Effect.runPromise(Effect.gen(function* () {
    const ctx = { systemOne: one, usage: yield* Usage } as unknown as Ctx
    return yield* pull(ctx, "fix the parser", limits)
  }).pipe(
    candidates ? Effect.provideService(MemoryPull, { candidates: () => Effect.succeed(candidates) }) : (e) => e,
    Effect.provide(Usage.layer),
  ))

test("pull: with the fake System One (scores everything 1), at most 12 facts and 2,000 characters", async () => {
  const many = await runPull(facts(30, 100))
  expect(many?.picked.length).toBe(12)
  expect(many?.shown.length).toBe(30)

  const long = await runPull(facts(30, 300)) // 6 × 300 = 1,800; a 7th would pass 2,000
  expect(long?.picked.length).toBe(6)
  expect(long!.picked.reduce((n, f) => n + f.text.length, 0)).toBeLessThanOrEqual(2000)

  expect((await runPull(facts(30, 10), fakeOne, { facts: 3 }))?.picked.length).toBe(3) // the limits can be set
})

test("pull: existence facts and observations are never shown or picked; low scores are dropped, the best first", async () => {
  const seen: Array<string> = []
  const scoring: SystemOne["Service"] = { ...fakeOne, relevant: (_goal, items) => Effect.sync(() => { seen.push(...items); return { scores: items.map((i) => (i.includes("low") ? 0.3 : i.includes("mid") ? 0.7 : 0.9)), tokens: { input: 0, output: 0 } } }) }
  const r = await runPull([
    { id: "a", text: "mid fact" }, { id: "b", text: "top fact" }, { id: "c", text: "low fact" },
    { id: "d", text: "the parser exists", kind: "existence" }, { id: "e", text: "saw it fail", kind: "observation" },
  ], scoring)

  expect(r?.picked.map((f) => f.id)).toEqual(["b", "a"])
  expect(r?.shown).toEqual(["a", "b", "c"])
  expect(seen.some((s) => s.includes("exists") || s.includes("saw it"))).toBe(false)
})

test("pull: no capability, or a System One failure, means no pull", async () => {
  let called = 0
  const counting: SystemOne["Service"] = { ...fakeOne, relevant: (g, i) => { called++; return fakeOne.relevant(g, i) } }
  expect(await runPull(undefined, counting)).toBeUndefined()
  expect(called).toBe(0)

  const failing: SystemOne["Service"] = { ...fakeOne, relevant: () => Effect.die("jev down") }
  expect(await runPull(facts(3, 10), failing)).toBeUndefined()
})

test("notesPull: the candidates are the active agent's note entries, every scope, no kind", async () => {
  const entries = { agent: ["- uses bun"], project: ["- tests run with bun test", "- api in src/api"], user: ["- prefers short answers"] }
  const memory = { ...noMemory, entries: (scope: keyof typeof entries) => Effect.succeed(entries[scope]) }
  const got = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* MemoryPull).candidates!("x") }).pipe(Effect.provide(notesPull), Effect.provideService(Memory, memory)))
  expect(got).toEqual([
    { id: "agent:1", text: "uses bun" }, { id: "project:1", text: "tests run with bun test" }, { id: "project:2", text: "api in src/api" }, { id: "user:1", text: "prefers short answers" },
  ])
})

// A whole turn (the real loop) with the fakes: what System Two and System One were shown, and what was reported.
const runTurn = (goal: string, options: { pull?: Capability; one?: SystemOne["Service"] } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "pull-turn-")), cwd = process.cwd()
  const config = Schema.decodeUnknownSync(ConfigSchema)({ testOptions: true, learnAfterTurn: false, systemTwo: { scopeCheck: false } })
  const prompts: Array<{ prompt: string; briefing?: string }> = [], views: Array<StepState> = []
  const one = options.one ?? fakeOne
  const watching: SystemOne["Service"] = { ...one, choose: (state, opts) => { views.push(state); return one.choose(state, opts) } }
  process.chdir(root)

  return Effect.runPromise(Effect.gen(function* () {
    const session = yield* makeSession("sessions")
    const fake = yield* SystemTwo
    const conversation = newConversation()
    conversation.briefing = "test project instructions"
    conversation.skills = { skills: [], diagnostics: [] }
    const provider: SystemTwo["Service"] = { ...fake, ask: (prompt, hooks?: Hooks) => Effect.sync(() => { prompts.push({ prompt, briefing: hooks?.briefing }); return { text: "answered", done: true, tokens: { input: 0, output: 0 } } }) }
    const reply = yield* turn(session, goal, 0, conversation).pipe(Effect.provideService(SystemTwo, provider))
    return { reply, prompts, views }
  }).pipe(
    options.pull ? Effect.provideService(MemoryPull, options.pull) : (e) => e,
    Effect.provideService(Config, config),
    Effect.provideService(Events, { emit: () => Effect.void }),
    Effect.provideService(AskUser, { ask: () => Effect.succeed([]) }),
    Effect.provideService(Memory, noMemory),
    Effect.provideService(SystemOne, watching), Effect.provide(FakeSystemTwo),
    Effect.provide(Usage.layer), Effect.provide(diskStore(root)),
    Effect.provideContext(Context.empty() as Context.Context<Needs>),
  )).finally(() => { process.chdir(cwd); rmSync(root, { recursive: true, force: true }) })
}

test("a turn: the pulled facts are in System One's view and System Two's first prompt, never the briefing; usage credits only the picked", async () => {
  const reports: Array<PullUsage> = []
  const scoring: SystemOne["Service"] = { ...fakeOne, relevant: (_goal, items) => Effect.succeed({ scores: items.map((i) => (i.includes("unrelated") ? 0 : 1)), tokens: { input: 0, output: 0 } }) }
  const capability = {
    candidates: () => Effect.succeed([{ id: "n1", text: "the parser lives in src/parse.ts" }, { id: "n2", text: "an unrelated note" }]),
    reportUsage: (u: PullUsage) => Effect.sync(() => { reports.push(u) }),
  }
  const { prompts, views } = await runTurn("where is the parser?", { pull: capability, one: scoring })

  expect(prompts.length).toBe(1)
  expect(prompts[0]!.prompt).toContain("the parser lives in src/parse.ts")
  expect(prompts[0]!.prompt).not.toContain("an unrelated note")
  expect(prompts[0]!.briefing).not.toContain("src/parse.ts")
  expect(views[0]!.facts).toEqual(["the parser lives in src/parse.ts"])
  expect(reports).toEqual([{ shown: ["n1", "n2"], picked: ["n1"], outcome: "done" }])
})

test("a turn with no pull capability, or a failing System One, goes as today", async () => {
  const plain = await runTurn("where is the parser?")
  expect(plain.prompts[0]!.prompt).not.toContain("Facts from memory")
  expect(plain.views[0]!.facts).toBeUndefined()

  const reports: Array<PullUsage> = []
  const failing: SystemOne["Service"] = { ...fakeOne, relevant: () => Effect.die("jev down") }
  const broken = await runTurn("where is the parser?", { one: failing, pull: { candidates: () => Effect.succeed(facts(3, 10)), reportUsage: (u) => Effect.sync(() => { reports.push(u) }) } })
  expect(broken.reply).toBe("answered")
  expect(broken.prompts[0]!.prompt).toBe(plain.prompts[0]!.prompt)
  expect(reports).toEqual([])
})

