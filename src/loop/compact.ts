import { Effect } from "effect"
import { toSaved } from "../base/images"
import { emit } from "../base/events"
import { type Ctx, timed } from "./turnkit"

// At the start of a turn, if System Two's thread has grown past `compactAt`: compact it (see the SystemTwo compact).
// System One judges which old tool outputs are still needed, against the new message and the last few exchanges.
// Aims for half of compactAt, so it isn't triggered again on the very next turn.
export const compactIfNeeded = (ctx: Ctx) =>
  Effect.gen(function* () {
    const { conversation, config } = ctx
    if (!conversation.size || conversation.size <= config.compactAt) return

    const score = (labels: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const questions = Object.fromEntries(labels.map((label, i) => [`o${i}`, {
          question: `Does the conversation still need this old tool output?\n${label}`,
          yes: "Still needed: the file or result is being worked on, or the goal refers to it", no: "Not needed any more: done with it, superseded, or unrelated to the goal",
        }]))
        const earlier = conversation.history.slice(-3).map((h) => `User: ${h.user} → answered: ${h.answer.slice(0, 300)}`)
        const { result: { answers } } = yield* timed(ctx, "systemOne", ctx.systemOne.judge({ goal: ctx.input.slice(0, 1000), earlier }, questions))
        return labels.map((_, i) => answers[`o${i}`] ?? 1)
      })

    const before = conversation.size, stashFrom = conversation.stash.size
    const done = yield* ctx.systemTwo.compact(conversation.thread, { score, stash: conversation.stash, size: before, target: Math.round(config.compactAt / 2) })
    yield* ctx.usage.add("systemTwo", 0, done.tokens)
    conversation.size = done.after

    const what = `${done.masked} old outputs hidden (~${Math.round(done.savedTokens / 1000)}k)${done.summarized ? `, ${done.summarized} older items summarized` : ""}`
    // The compacted thread as a whole (resuming starts from it), and whatever was hidden (so more_output still works).
    yield* ctx.session.record("compact", what, { before, after: done.after, thread: conversation.thread.map(toSaved) }).pipe(Effect.ignore)
    for (const [id, output] of [...conversation.stash].slice(stashFrom)) yield* ctx.session.record("stash", id, { output }).pipe(Effect.ignore)
    conversation.saved = { thread: conversation.thread.length, stash: conversation.stash.size } // the snapshot has all of it
    yield* emit("compact", ctx.depth, `compacted: ${Math.round(before / 1000)}k → ~${Math.round(done.after / 1000)}k tokens · ${what}`)
  })
