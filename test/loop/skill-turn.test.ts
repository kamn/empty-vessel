import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Schema } from "effect"
import { Config, ConfigSchema } from "../../src/base/config"
import { Events } from "../../src/base/events"
import { Memory } from "../../src/base/memory"
import { makeSession } from "../../src/base/session"
import { diskStore } from "../../src/base/store"
import { Usage } from "../../src/base/usage"
import { turn } from "../../src/loop/turn"
import { newConversation, type Needs } from "../../src/loop/turnkit"
import { FakeSystemOne } from "../../src/system-one/systemone"
import { FakeSystemTwo, SystemTwo } from "../../src/system-two/systemtwo"
import { AskUser } from "../../src/ui/ask"

// Use the real turn loop: without explicit routing the fake System One picks echo, not System Two.
test("an explicit skill forces escalation and restores saved skill instructions before the provider runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "skill-turn-")), cwd = process.cwd()
  const config = Schema.decodeUnknownSync(ConfigSchema)({ testOptions: true, learnAfterTurn: false, systemTwo: { scopeCheck: false } })
  process.chdir(root)

  try {
    await Effect.runPromise(Effect.gen(function* () {
      const session = yield* makeSession("sessions")
      const fake = yield* SystemTwo
      const conversation = newConversation()
      conversation.briefing = "test project instructions"
      conversation.skills = { skills: [], diagnostics: [] }
      conversation.explicitSkill = true
      conversation.activeSkills = { testing: "Retained instructions with source and arguments" }
      conversation.activeSkillsPending = true
      let called = 0
      const provider: SystemTwo["Service"] = {
        ...fake,
        ask: (prompt) => Effect.sync(() => {
          called++
          expect(prompt).toContain("Retained instructions with source and arguments")
          expect(prompt).toContain("Goal: Run the selected skill")
          return { text: "selected skill ran", done: true, tokens: { input: 0, output: 0 } }
        }),
      }
      expect(yield* turn(session, "Run the selected skill", 0, conversation).pipe(Effect.provideService(SystemTwo, provider))).toBe("selected skill ran")
      expect(called).toBe(1)
      expect(conversation.explicitSkill).toBeUndefined()
      const events = readFileSync(join(session.dir, "main.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
      expect(events.filter(event => event.role === "step").map(event => event.text)).toEqual([expect.stringContaining("escalate → ok")])
    }).pipe(
      Effect.provideService(Config, config),
      Effect.provideService(Events, { emit: () => Effect.void }),
      Effect.provideService(AskUser, { ask: () => Effect.succeed([]) }),
      Effect.provideService(Memory, { snapshot: Effect.succeed(""), add: () => Effect.void, replace: () => Effect.void, remove: () => Effect.void, entries: () => Effect.succeed([]), file: () => Effect.succeed("") }),
      Effect.provide(FakeSystemOne), Effect.provide(FakeSystemTwo),
      Effect.provide(Usage.layer), Effect.provide(diskStore(root)),
      Effect.provideContext(Context.empty() as Context.Context<Needs>),
    ))
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

// A file is given to System Two when a prompt carrying it is sent, not when it's packed: a turn System One finishes
// alone (echo) never shows it, so a later turn that escalates must still send it.
test("an @mentioned file counts as given only once System Two's prompt carries it", async () => {
  const root = mkdtempSync(join(tmpdir(), "mention-turn-")), cwd = process.cwd()
  const config = Schema.decodeUnknownSync(ConfigSchema)({ testOptions: true, learnAfterTurn: false, systemTwo: { scopeCheck: false } })
  require("node:fs").writeFileSync(join(root, "a.ts"), "export const a = 1\n")
  process.chdir(root)

  try {
    await Effect.runPromise(Effect.gen(function* () {
      const session = yield* makeSession("sessions")
      const fake = yield* SystemTwo
      const conversation = newConversation()
      conversation.briefing = "test project instructions"
      conversation.skills = { skills: [], diagnostics: [] }
      const prompts: string[] = []
      const provider: SystemTwo["Service"] = { ...fake, ask: (prompt) => Effect.sync(() => { prompts.push(prompt); return { text: "answered", done: true, tokens: { input: 0, output: 0 } } }) }
      const run = (input: string) => turn(session, input, 0, conversation).pipe(Effect.provideService(SystemTwo, provider))

      yield* run("look at @a.ts") // the fake System One echoes it: no System Two
      expect(prompts).toEqual([])
      expect(conversation.files.has("a.ts")).toBe(false)

      yield* run("what does @a.ts export?") // a question: escalates
      expect(prompts[0]).toContain('<file path="a.ts">\nexport const a = 1')
      expect(conversation.files.has("a.ts")).toBe(true)
    }).pipe(
      Effect.provideService(Config, config),
      Effect.provideService(Events, { emit: () => Effect.void }),
      Effect.provideService(AskUser, { ask: () => Effect.succeed([]) }),
      Effect.provideService(Memory, { snapshot: Effect.succeed(""), add: () => Effect.void, replace: () => Effect.void, remove: () => Effect.void, entries: () => Effect.succeed([]), file: () => Effect.succeed("") }),
      Effect.provide(FakeSystemOne), Effect.provide(FakeSystemTwo),
      Effect.provide(Usage.layer), Effect.provide(diskStore(root)),
      Effect.provideContext(Context.empty() as Context.Context<Needs>),
    ))
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})

test("a goal finished by the last allowed step isn't marked '(step limit)'", async () => {
  const root = mkdtempSync(join(tmpdir(), "limit-turn-")), cwd = process.cwd()
  const config = Schema.decodeUnknownSync(ConfigSchema)({ testOptions: true, learnAfterTurn: false, maxSteps: 1, systemTwo: { scopeCheck: false } })
  process.chdir(root)

  try {
    await Effect.runPromise(Effect.gen(function* () {
      const session = yield* makeSession("sessions")
      const conversation = newConversation()
      conversation.briefing = "test project instructions"
      conversation.skills = { skills: [], diagnostics: [] }

      expect(yield* turn(session, "hello", 0, conversation)).toBe("echo: hello") // echo answers it in its one step
    }).pipe(
      Effect.provideService(Config, config),
      Effect.provideService(Events, { emit: () => Effect.void }),
      Effect.provideService(AskUser, { ask: () => Effect.succeed([]) }),
      Effect.provideService(Memory, { snapshot: Effect.succeed(""), add: () => Effect.void, replace: () => Effect.void, remove: () => Effect.void, entries: () => Effect.succeed([]), file: () => Effect.succeed("") }),
      Effect.provide(FakeSystemOne), Effect.provide(FakeSystemTwo),
      Effect.provide(Usage.layer), Effect.provide(diskStore(root)),
      Effect.provideContext(Context.empty() as Context.Context<Needs>),
    ))
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})
