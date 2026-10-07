import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Effect, Exit, Fiber } from "effect"
import { discoverSkills } from "../src/base/skills"
import type { SessionHandle } from "../src/base/session"
import { interactionOperations, makeSessionRunner } from "../src/interaction"
import { routeSkillCommand, skillCommand, skillReservedCommands } from "../src/loop/skill-commands"
import { newConversation } from "../src/loop/turnkit"

const result = { reply: "ok", remembered: [], usage: [], brief: { turn: "turn", session: "total" } }
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provideContext(Context.empty() as Context.Context<Exclude<R, never>>)))
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "skill-commands-"))
  const home = join(root, "home")
  const add = (name: string, fields = "", body = "Use careful reasoning.") => {
    const dir = join(root, ".empty-vessel", "skills", name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Test ${name}\n${fields}---\n${body}\n`)
  }
  add("explain")
  add("model")
  add("hidden", "user-invocable: false\n")
  add("manual", "disable-model-invocation: true\n")
  const conversation = newConversation()
  conversation.skills = discoverSkills(root, home)
  const records: { kind: string; text: string; data?: Readonly<Record<string, unknown>> }[] = []
  const session: SessionHandle = { id: "test", key: "sessions/test", dir: root,
    record: (kind, text, data) => Effect.sync(() => { records.push({ kind, text, data }) }),
  }
  const operations: typeof interactionOperations = {
    ...interactionOperations,
    firstAgent: (_session, _conversation, _input, services) => Effect.succeed({ services, line: undefined }),
    answer: () => Effect.succeed(result),
    stopped: () => Effect.succeed("(stopped)"),
    skillCommand: (s: SessionHandle, c: ReturnType<typeof newConversation>, input: string) => skillCommand(s, c, input, root, home),
  }
  return { root, home, add, conversation, session, records, operations, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
const events = { emit: () => Effect.void }

test("pure routing preserves built-ins and unknown slash commands", () => {
  expect(routeSkillCommand("/skills", [])).toEqual({ kind: "list" })
  expect(routeSkillCommand("/skills reload", [])).toEqual({ kind: "reload" })
  expect(routeSkillCommand("/skills typo", [])?.kind).toBe("error")
  expect(routeSkillCommand("/skill   ", [])?.kind).toBe("error")
  expect(routeSkillCommand("/skill absent words", [])).toEqual({ kind: "invoke", name: "absent", arguments: "words" })
  expect(routeSkillCommand("/explain one\ntwo", ["explain"])).toEqual({ kind: "invoke", name: "explain", arguments: "one\ntwo" })
  expect(routeSkillCommand("/absent", ["explain"])).toBeUndefined()
  expect(routeSkillCommand("normal message", ["normal"])).toBeUndefined()
  for (const name of skillReservedCommands) {
    if (name === "skill" || name === "skills") continue
    expect(routeSkillCommand(`/${name} args`, [name])).toBeUndefined()
    expect(routeSkillCommand(`/skill ${name} args`, [name])).toEqual({ kind: "invoke", name, arguments: "args" })
  }
})

test("list and reload stay local; reload refreshes metadata and marks briefing pending", async () => {
  const f = fixture()
  try { await run(Effect.gen(function* () {
    let turns = 0
    const runner = yield* makeSessionRunner(f.session, f.conversation, { events }, { ...f.operations, answer: () => { turns++; return Effect.succeed(result) } })
    expect((yield* runner.run("/skills")).reply).toContain("explain")
    f.add("fresh")
    expect((yield* runner.run("/skills")).reply).not.toContain("fresh")
    expect((yield* runner.run("/skills reload")).reply).toContain("fresh")
    expect(f.conversation.skillCatalogPending).toBe(true)
    expect(f.conversation.history).toEqual([])
    expect(f.records).toEqual([])
    expect(turns).toBe(0)
  })) } finally { f.cleanup() }
})

for (const input of ["/explain some arguments", "/skill explain some arguments", "/skill model some arguments", "/manual some arguments"]) {
  test(`host activates full content: ${input}`, async () => {
    const f = fixture()
    try { await run(Effect.gen(function* () {
      let sent = ""
      const runner = yield* makeSessionRunner(f.session, f.conversation, { events }, { ...f.operations,
        answer: (_s, text, conversation) => Effect.sync(() => {
          sent = text
          expect(conversation.explicitSkill).toBe(true)
          expect(text).toContain("Use careful reasoning.")
          expect(text).toContain("some arguments")
          return result
        }),
      })
      yield* runner.run(input)
      const name = input.includes("model") ? "model" : input.includes("manual") ? "manual" : "explain"
      expect(f.records).toEqual([{ kind: "skill", text: name, data: { content: sent } }])
      expect(f.conversation.activeSkills?.[name]).toBe(sent)
      expect(f.conversation.explicitSkill).toBe(false)
      expect(f.conversation.history).toEqual([{ user: input, answer: "ok" }])
    })) } finally { f.cleanup() }
  })
}

test("malformed, unknown and disabled explicit invocations fail without activation", async () => {
  const f = fixture()
  try { await run(Effect.gen(function* () {
    const runner = yield* makeSessionRunner(f.session, f.conversation, { events }, f.operations)
    for (const input of ["/skill", "/skill missing", "/skill ../escape", "/skill hidden", "/hidden", "/skills extra"]) {
      f.conversation.explicitSkill = true
      expect(Exit.isFailure(yield* Effect.exit(runner.run(input)))).toBe(true)
      expect(f.conversation.explicitSkill).toBe(false)
    }
    expect(f.records).toEqual([])
    expect(f.conversation.activeSkills).toEqual(undefined)
    expect(f.conversation.history).toEqual([])
  })) } finally { f.cleanup() }
})

test("unknown shorthand passes through unchanged and built-in model wins", async () => {
  const f = fixture()
  try { await run(Effect.gen(function* () {
    const inputs: string[] = []
    const runner = yield* makeSessionRunner(f.session, f.conversation, { events }, { ...f.operations,
      modelCommand: (_s, _c, name, services) => Effect.succeed({ reply: `model:${name}`, services }),
      answer: (_s, input) => Effect.sync(() => { inputs.push(input); return result }),
    })
    expect((yield* runner.run("/model chosen")).reply).toBe("model:chosen")
    yield* runner.run("/not-a-skill abc")
    expect(inputs).toEqual(["/not-a-skill abc"])
    expect(f.records).toEqual([])
  })) } finally { f.cleanup() }
})

test("answer failure clears explicit activation before the next turn", async () => {
  const f = fixture()
  try { await run(Effect.gen(function* () {
    const runner = yield* makeSessionRunner(f.session, f.conversation, { events }, { ...f.operations, answer: () => Effect.die("answer failed") })
    expect(Exit.isFailure(yield* Effect.exit(runner.run("/explain")))).toBe(true)
    expect(f.conversation.explicitSkill).toBe(false)
    expect(f.conversation.history).toEqual([])
  })) } finally { f.cleanup() }
})

test("stopping activation clears explicit routing and releases the shared runner", async () => {
  const f = fixture()
  try { await run(Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let calls = 0
    const runner = yield* makeSessionRunner(f.session, f.conversation, { events }, { ...f.operations,
      answer: () => ++calls === 1 ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)) : Effect.succeed(result),
    })
    const turn = yield* Effect.forkChild(runner.run("/explain"))
    yield* Deferred.await(started)
    yield* runner.stop
    expect((yield* Fiber.join(turn)).reply).toBe("(stopped)")
    expect(f.conversation.explicitSkill).toBe(false)
    expect((yield* runner.run("next")).reply).toBe("ok")
  })) } finally { f.cleanup() }
})

test("first command discovery still schedules the model catalog briefing", async () => {
  const f = fixture()
  try { await run(Effect.gen(function* () {
    f.conversation.skills = undefined
    const runner = yield* makeSessionRunner(f.session, f.conversation, { events }, f.operations)
    yield* runner.run("/skills")
    expect(f.conversation.skillCatalogPending).toBe(true)
    expect((f.conversation as ReturnType<typeof newConversation>).skills?.skills.some(s => s.name === "explain")).toBe(true)
  })) } finally { f.cleanup() }
})

test("hyphenated skill names do not collide with built-in command prefixes", async () => {
  const f = fixture()
  try { await run(Effect.gen(function* () {
    const names = ["model-notes", "agent-notes", "refine-notes", "review-notes"]
    for (const name of names) f.add(name)
    f.conversation.skills = discoverSkills(f.root, f.home)
    const runner = yield* makeSessionRunner(f.session, f.conversation, { events }, f.operations)
    for (const name of names) expect((yield* runner.run(`/${name}`)).reply).toBe("ok")
    expect(f.records.map(record => record.text)).toEqual(names)
  })) } finally { f.cleanup() }
})

test("recording failure does not mark a skill active or leave explicit routing enabled", async () => {
  const f = fixture()
  try { await run(Effect.gen(function* () {
    const session: SessionHandle = { ...f.session, record: () => Effect.die("record failed") }
    const runner = yield* makeSessionRunner(session, f.conversation, { events }, f.operations)
    expect(Exit.isFailure(yield* Effect.exit(runner.run("/explain")))).toBe(true)
    expect(f.conversation.explicitSkill).toBe(false)
    expect(f.conversation.activeSkills).toBeUndefined()
  })) } finally { f.cleanup() }
})

test("import routing handles quoted paths and requires one explicit scope without shell expansion", () => {
  expect(routeSkillCommand('/skills import "/tmp/my skill" --scope project', [])).toEqual({ kind: "import", path: "/tmp/my skill", scope: "project" })
  expect(routeSkillCommand("/skills import './my skill' --scope=personal", [])).toEqual({ kind: "import", path: "./my skill", scope: "personal" })
  expect(routeSkillCommand('/skills import "$(touch sentinel)" --scope project', [])).toEqual({ kind: "import", path: "$(touch sentinel)", scope: "project" })
  expect(routeSkillCommand('/skills import ./my\\ skill --scope project', [])).toEqual({ kind: "import", path: "./my skill", scope: "project" })
  for (const args of ["", "/tmp/source", "/tmp/source --scope other", "/tmp/source --scope project --force", '"unterminated --scope project', '"" --scope personal', "/tmp/source --scope project --scope personal"]) {
    expect(routeSkillCommand(`/skills import ${args}`, [])?.kind).toBe("error")
  }
})

for (const scope of ["project", "personal"] as const) {
  test(`shared runner imports ${scope} locally, refreshes discovery and refuses overwrite`, async () => {
    const f = fixture()
    const source = join(f.root, "incoming package")
    mkdirSync(source)
    writeFileSync(join(source, "SKILL.md"), "---\nname: imported\ndescription: Imported workflow\n---\nDo not run me while importing.\n")
    const destination = scope === "project" ? join(f.root, ".empty-vessel/skills/imported") : join(f.home, "skills/imported")
    let turns = 0

    try { await run(Effect.gen(function* () {
      const runner = yield* makeSessionRunner(f.session, f.conversation, { events }, { ...f.operations, answer: () => { turns++; return Effect.succeed(result) } })
      const reply = yield* runner.run(`/skills import "${source}" --scope ${scope}`)
      expect(reply.reply).toContain("Imported imported")
      expect(reply.reply).toContain(destination)
      expect(reply.usage).toEqual([])
      expect(f.conversation.skills?.skills.some(s => s.name === "imported")).toBe(true)
      expect(f.conversation.skillCatalogPending).toBe(true)
      expect(f.conversation.explicitSkill).toBe(false)
      expect(f.conversation.activeSkills).toBeUndefined()
      expect(turns).toBe(0)
      expect(f.records.filter(record => record.kind === "skill")).toEqual([])
      const again = yield* Effect.exit(runner.run(`/skills import "${source}" --scope ${scope}`))
      expect(Exit.isFailure(again)).toBe(true)
      expect(turns).toBe(0)
      expect((yield* runner.run("/skills")).reply).toContain("imported")
    })) } finally { f.cleanup() }
  })
}
