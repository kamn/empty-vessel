import { Context, Effect, Layer, Schema } from "effect"
import { emit } from "../base/events"
import { join } from "node:path"
import { projectDir } from "../base/project"
import { type SaveAs, saveCheck, vetCheck } from "./checks"
import { Memory, type Scope } from "../base/memory"
import { appendHistory } from "../base/files"
import { EMPTY_VESSEL_HOME } from "../base/home"
import { Kernel } from "../tools/kernel-service"
import { Ask, type AskError } from "../system-two/ask"
import type { Tokens } from "../base/usage"

// What the reviewer may propose. Every check must come from a command that passed in the turn (`from_command`),
// so code can check it (step 4b) before it's saved: the maker isn't the checker.
const ProposedCheck = Schema.Struct({
  action: Schema.Literals(["add", "fix"]),
  name: Schema.String,
  description: Schema.String,
  template: Schema.String,
  slots: Schema.Array(Schema.Struct({ name: Schema.String, values: Schema.Array(Schema.String) })), // several values = several arguments
  scope: Schema.Literals(["project", "general"]),
  requires: Schema.Array(Schema.String),
  from_command: Schema.String,
  why: Schema.String,
})
const Proposals = Schema.Struct({
  checks: Schema.Array(ProposedCheck),
  // knowledge learned the hard way; agent: about the user or this computer (a missing program), read in every project
  notes: Schema.Array(Schema.Struct({ text: Schema.String, scope: Schema.Literals(["project", "agent"]) })),
  open_items: Schema.Array(Schema.String),
  repeated_failures: Schema.Array(Schema.String),
})
type Proposals = typeof Proposals.Type
const NONE: Proposals = { checks: [], notes: [], open_items: [], repeated_failures: [] }

// The reviewer's job, and the rules that keep it from saving junk.
const INSTRUCTIONS = [
  "You review finished turns of a coding agent (empty-vessel), one or several (refine sends a batch, each turn under its own heading; \"this turn\" below means any of them), and keep what it learned the hard way, so later tasks don't learn it again.",
  "Keep something only if the turn shows failed attempts before it worked, or it needed something that can't be read from package.json or the README (an environment variable, a special flag, a non-standard script). Things the agent got right first time aren't worth keeping.",
  "Knowledge (how things work here, used in different ways) goes in notes, one sentence each, e.g. \"Run quick scripts against src/ with BABEL_ENV=test npx babel-node (without it the imports fail).\" Scope project for anything about this repo (its setup, commands, versions, conventions); agent only for what holds in every project (the user's preferences, a program missing from this computer).",
  "Keep a note only if it would help a different task in this repo (or in every project), not just this bug: how one function should be fixed is not a note.",
  "A repeatable pass/fail action goes in checks. Propose a check only if all of these hold:",
  "- it comes from a command that PASSED in this turn: copy that command exactly into from_command;",
  "- it will be needed again in this project, not a one-off script written for this bug (no inline node -e or babel-node -e assertions);",
  "- it is ONE command: no &&, ; or || (split into separate checks);",
  "- the parts that change between uses become {slots} in template (e.g. npx jest test/plugin/{plugin}.test.js --runInBand), with this turn's values in slots (a slot holding several files lists each one separately in values);",
  "- scope general only if it works unchanged in any project of this kind (then list the files that must exist in requires, e.g. pnpm-lock.yaml); otherwise project, with requires empty.",
  "Use action fix (same name) when an existing check failed in this turn and the turn shows the corrected command; otherwise add. Don't add one that duplicates an existing check.",
  "open_items: things the work or the answer left undone, one line each. repeated_failures: a command or check that failed more than once, with the likely cause.",
  "Saved notes so far are listed with the checks: don't repeat them. Fewer is better: empty lists are a fine answer.",
].join("\n")

// The reviewer: one question to System Two's model (src/system-two/ask.ts: the chosen backend's own, with reasoning),
// its answer forced into Proposals. `ask`: the same, for any other look back at a turn (adoption's end-of-turn
// questions, src/loop/adopt.ts). The reviewer's job (its instructions, what it may propose, and code checking it) is
// empty-vessel's; only the model call is the plugin's.
export class Reviewer extends Context.Service<Reviewer, {
  readonly review: (turn: string) => Effect.Effect<{ proposals: Proposals; tokens: Tokens }>
  readonly ask: <S extends Schema.Top>(instructions: string, schema: S, input: string) => Effect.Effect<{ value: S["Type"]; tokens: Tokens }, AskError, S["DecodingServices"]>
}>()("empty-vessel/Reviewer") {}

export const ReviewerLive = Layer.effect(
  Reviewer,
  Effect.gen(function* () {
    const { ask } = yield* Ask
    return Reviewer.of({
      ask,
      review: (turn) =>
        ask(INSTRUCTIONS, Proposals, turn).pipe(
          Effect.map(({ value, tokens }) => ({ proposals: value, tokens })),
          // Reviewing is optional: a failed review proposes nothing and the turn is unaffected (quietly, when there's
          // no model at all: System Two is the fake).
          Effect.catch((e) => (e.noModel ? Effect.void : emit("error", 0, `reviewer failed: ${e.message}`)).pipe(Effect.as({ proposals: NONE, tokens: { input: 0, output: 0 } }))),
        ),
    })
  }),
)

// Apply what the reviewer proposed. A check is saved only if vetCheck accepts it and its from_command passes (the
// reviewer proposes, code verifies); open items and repeated failures go in the project's notes. `passed` holds only
// the checks System Two yielded to System One: a command it ran itself, with bash() in a kernel cell, runs in the
// cell's worker where the host never sees it, so it's run once more here (vetted first: it can't change files).
export const applyProposals = (proposals: Proposals, passed: ReadonlyArray<string>, root: string, source: string, home = EMPTY_VESSEL_HOME) =>
  Effect.gen(function* () {
    const results: Array<string> = []
    const { exec } = yield* Kernel // a check runs where the cells' files are
    const passes = (command: string) => passed.includes(command) ? Effect.succeed(true) : exec(command, 120_000).pipe(Effect.map((out) => out.startsWith("exit 0")))

    for (const p of proposals.checks) {
      const args = Object.fromEntries(p.slots.map((s) => [s.name, s.values.length === 1 ? s.values[0]! : s.values]))
      const save: SaveAs = { name: p.name, description: p.description, template: p.template, args, scope: p.scope, ...(p.requires.length ? { requires: p.requires } : {}) }
      const refused = vetCheck(save, p.from_command, root) ?? ((yield* passes(p.from_command)) ? undefined : "its command doesn't pass")
      if (!refused) yield* saveCheck(root, save, source, home)
      results.push(`${refused ? `not saved (${refused})` : `saved (${p.scope})`}: ${p.name}: ${p.template}`)
    }

    // Learned notes: added to memory (System Two is given it next session); logged like everything else.
    const memory = yield* Memory
    const learned: Array<{ text: string; scope: Scope }> = []
    for (const { text, scope } of proposals.notes) {
      const refused = yield* memory.add(scope, text).pipe(Effect.as(undefined), Effect.catch((e) => Effect.succeed(e.message)))
      results.push(refused ? `not learned (${refused}): ${text}` : `learned (${scope}): ${text}`)
      if (!refused) learned.push({ text, scope })
    }

    const notes = join(projectDir(root), "notes.jsonl")
    for (const { text, scope } of learned) yield* appendHistory(notes, { kind: "learned", scope, text, source })
    for (const text of proposals.open_items) yield* appendHistory(notes, { kind: "open", text, source })
    for (const text of proposals.repeated_failures) yield* appendHistory(notes, { kind: "repeated failure", text, source })

    return results
  })
