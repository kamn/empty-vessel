import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect } from "effect"
import type { SessionHandle } from "../../src/base/session"
import { interactionOperations, makeSessionRunner } from "../../src/interaction"
import { skillCommand } from "../../src/loop/skill-commands"
import { newConversation } from "../../src/loop/turnkit"
import { init, Message, TurnRunner, update } from "../../src/ui/tui/app"

test("TUI Enter executes /flag-check through the session runner, but /flag stays local", async () => {
  const root = mkdtempSync(join(tmpdir(), "tui-skills-"))
  const dir = join(root, ".empty-vessel", "skills", "flag-check")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), "---\nname: flag-check\ndescription: Check flags\n---\nInspect the flag implementation.\n")
  const conversation = newConversation()
  const records: { role: string; text: string }[] = []
  const session: SessionHandle = { id: "test", key: "sessions/test", dir: root,
    record: (role, text) => Effect.sync(() => { records.push({ role, text }) }) }
  const program = Effect.gen(function* () {
    let turns = 0
    const runner = yield* makeSessionRunner(session, conversation, { events: { emit: () => Effect.void } }, {
      ...interactionOperations,
      skillCommand: (s, c, input) => skillCommand(s, c, input, root, join(root, "home")),
      firstAgent: (_s, _c, _input, services) => Effect.succeed({ services, line: undefined }),
      answer: (_s, input, c) => Effect.sync(() => {
        turns++
        expect(c.explicitSkill).toBe(true)
        expect(input).toContain("Inspect the flag implementation.")
        expect(input).toContain("my arguments")
        return { reply: "skill ran", remembered: [], usage: [], brief: { turn: "turn", session: "total" } }
      }),
    })
    const flags: string[] = []
    const service = { ...runner, flag: (note: string) => Effect.sync(() => { flags.push(note) }) }
    let model = init("test")
    for (const text of ["/flag-check my arguments", "/flag", "/flag note", "/flag\ttab note"]) {
      model = update(model, Message.PressedKey({ key: text })).model
      const submitted = update(model, Message.PressedKey({ key: "\r" }))
      expect(submitted.commands).toHaveLength(1)
      // Execute the command returned by actual input submission, not a fabricated RunTurn.
      const message = yield* submitted.commands![0]!.effect.pipe(Effect.provideService(TurnRunner, service))
      model = update(submitted.model, message).model
    }
    expect(turns).toBe(1)
    expect(flags).toEqual(["", "note", "tab note"])
    expect(records).toEqual([{ role: "skill", text: "flag-check" }])
    expect(conversation.explicitSkill).toBe(false)
    expect(conversation.history).toEqual([{ user: "/flag-check my arguments", answer: "skill ran" }])
    expect(model.printed.some(line => line.kind === "reply" && line.text === "skill ran")).toBe(true)
  }).pipe(Effect.scoped)
  try {
    await Effect.runPromise(program.pipe(Effect.provideContext(Context.empty() as Context.Context<Effect.Services<typeof program>>)))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
