import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Schema } from "effect"
import { projectDir } from "../../src/base/project"
import { diskStore } from "../../src/base/store"
import { memoryOnStore } from "../../src/base/memory"
import { applyProposals, Reviewer, ReviewerLive } from "../../src/learning/reviewer"
import { makeClaudeAsk } from "../../src/plugins/claude/claude"
import { Ask, AskError, FakeAsk } from "../../src/system-two/ask"

const review = (ask: Layer.Layer<Ask>, turn = "a turn") =>
  Effect.runPromise(Effect.gen(function* () { return yield* (yield* Reviewer).review(turn) }).pipe(Effect.provide(ReviewerLive.pipe(Layer.provide(ask)))))

test("the reviewer asks whichever System Two was chosen (Ask), and proposes nothing, quietly, when there's no model", async () => {
  let asked = ""
  const answering = Layer.succeed(Ask, {
    ask: (instructions, schema, input) => Effect.gen(function* () {
      asked = `${instructions.slice(0, 30)}|${input}`
      const value = yield* Schema.decodeUnknownEffect(schema)({ checks: [], notes: [{ text: "Run tests with BABEL_ENV=test", scope: "project" }], open_items: [], repeated_failures: [] })
      return { value, tokens: { input: 10, output: 2 } }
    }).pipe(Effect.mapError((e) => new AskError({ message: String(e) }))),
  })
  const r = await review(answering, "the digest")
  expect(r.proposals.notes).toEqual([{ text: "Run tests with BABEL_ENV=test", scope: "project" }])
  expect(asked).toBe("You review finished turns of a|the digest")

  expect(await review(FakeAsk)).toEqual({ proposals: { checks: [], notes: [], open_items: [], repeated_failures: [] }, tokens: { input: 0, output: 0 } })
})

test("Claude's Ask: one claude -p call with the instructions, the model and effort, no tools, the answer forced into the schema and checked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-claude-ask-"))
  const fake = join(dir, "claude")
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat "${dir}/reply"\n`)
  chmodSync(fake, 0o755)
  const Verdict = Schema.Struct({ applied: Schema.Boolean })
  const ask = (_schema: typeof Verdict, reply: object) => {
    writeFileSync(join(dir, "reply"), JSON.stringify(reply))
    return Effect.runPromise(Effect.gen(function* () { return yield* (yield* Ask).ask("Judge the turn.", Verdict, "the digest") }).pipe(
      Effect.provide(makeClaudeAsk("opus", "high")), Effect.map((r): unknown => r.value), Effect.catch((e) => Effect.succeed(`error: ${e.message}`))))
  }

  const prev = process.env.EMPTY_VESSEL_CLAUDE_BIN
  process.env.EMPTY_VESSEL_CLAUDE_BIN = fake
  try {
    expect(await ask(Verdict, { is_error: false, structured_output: { applied: true }, usage: { input_tokens: 5, output_tokens: 1 } })).toEqual({ applied: true })
    const args = readFileSync(join(dir, "args"), "utf8").split("\n")
    expect(args.slice(0, 2)).toEqual(["-p", "the digest"])
    for (const [flag, value] of [["--model", "opus"], ["--effort", "high"], ["--tools", ""], ["--system-prompt", "Judge the turn."]]) expect(args[args.indexOf(flag!) + 1]).toBe(value!)
    expect(args).toContain("--json-schema")

    expect(await ask(Verdict, { is_error: false, structured_output: { applied: "yes" } })).toContain("error: Claude's answer doesn't fit")
  } finally { process.env.EMPTY_VESSEL_CLAUDE_BIN = prev ?? ""; if (!prev) delete process.env.EMPTY_VESSEL_CLAUDE_BIN }
})

test("applyProposals: a check System Two ran itself (in a cell, not yielded) is run once more and saved only if it passes", async () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-")), root = mkdtempSync(join(tmpdir(), "empty-vessel-proj-"))
  const check = (name: string, command: string) => ({ action: "add" as const, name, description: name, template: command, slots: [], scope: "project" as const, requires: [], from_command: command, why: "" })
  const said = await Effect.runPromise(applyProposals({ checks: [check("passes", "true"), check("fails", "false")], notes: [], open_items: [], repeated_failures: [] }, [], root, "test", home).pipe(Effect.provide(memoryOnStore(root).pipe(Layer.provide(diskStore(home))))))

  expect(said).toEqual(["saved (project): passes: true", "not saved (its command doesn't pass): fails: false"])
  expect(JSON.parse(readFileSync(join(projectDir(root, home), "checks.json"), "utf8")).map((c: { name: string }) => c.name)).toEqual(["passes"])
})
