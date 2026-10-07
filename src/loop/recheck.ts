import { Effect, Option, Schema } from "effect"
import { Fill } from "../system-two/fill"
import type { Choice } from "../tools/judge-rules"

// The kernel's judge (src/tools/kernel-builtins.ts): the questions System One couldn't settle, answered by one direct model
// call (fill: a small model given only this prompt, its answer forced to one of each question's options). Not a
// sub-agent: a sub-agent got the whole task as its goal and could re-judge and re-check again.
// A failed call leaves the questions unsure.
export const recheck = (goal: string, evidence: string, questions: Readonly<Record<string, Choice>>) =>
  Effect.gen(function* () {
    const keys = Object.keys(questions)
    const schema = Schema.Struct(Object.fromEntries(keys.map((k) => [k, Schema.Literals(Object.keys(questions[k]!.options) as [string, ...Array<string>]).annotate({ description: questions[k]!.question })])))
    const asked = keys.map((k) => `${k}: ${questions[k]!.question}\n${Object.entries(questions[k]!.options).map(([o, d]) => `  - ${o}: ${d}`).join("\n")}`).join("\n\n")
    const prompt = `${goal}\n\nAnswer each question from the evidence below, with one of its options.\n\n${asked}\n\nEvidence:\n${evidence}`

    const filled = yield* (yield* Fill).fill("answer", schema, prompt).pipe(Effect.option)
    const answers = Option.isSome(filled) ? (filled.value.args as Record<string, string>) : Object.fromEntries(keys.map((k) => [k, "unsure"]))
    return { answers, note: Option.isSome(filled) ? "" : "re-check failed" }
  })
