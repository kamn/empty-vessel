import { Effect } from "effect"
import { emit } from "../base/events"
import { Background } from "../base/background"
import { loadChecks } from "../learning/checks"
import { Memory } from "../base/memory"
import { applyProposals, Reviewer } from "../learning/reviewer"
import { askAfterTurn, shouldAsk } from "./adopt"
import { type Ctx, timed, type TurnState, unseenBySystemTwo } from "./turnkit"

// After a turn in which System Two worked, System One decides whether it's worth a review (the reviewer is the expensive part).
const REVIEW = {
  tooling: { question: "Did the agent need failed attempts before a command or check worked?", yes: "Something only worked after failing first", no: "Everything worked on the first try" },
  repeats: { question: "Did the same command or check fail more than once?", yes: "Something failed more than once", no: "No repeated failures" },
  open: { question: "Does the answer mention something left undone or out of scope?", yes: "Something was left open", no: "Everything asked for was done" },
}
const REVIEW_AT = 0.5

// The end of a turn: remember what System One did, then (if System Two worked) System One's review gate, and the reviewer in the
// background for a flagged turn (the answer doesn't wait for it; empty-vessel waits before exiting, see Background).
export const endTurn = (ctx: Ctx, state: TurnState, reply: string) =>
  Effect.gen(function* () {
    const did = state.did.join(" · ") || "nothing (done straight away)"
    ctx.conversation.actions.push(did)
    yield* ctx.session.record("actions", did).pipe(Effect.ignore) // for resuming
    if (unseenBySystemTwo(state.steps.at(-1))) ctx.conversation.unseen.push({ user: ctx.input, answer: reply })

    // Keep conversation history above, but skip both automatic learning paths below.
    if (!ctx.config.learnAfterTurn) return

    // Adoption, part 2: System Two looks back at the tools on trial and what could become a tool (in the background).
    if (shouldAsk(ctx, state)) yield* (yield* Background).run(askAfterTurn(ctx, state, reply).pipe(Effect.ignore))

    if (!state.work.length) return
    const { result: { answers } } = yield* timed(ctx, "systemOne", ctx.systemOne.judge({ goal: ctx.input.slice(0, 1000), work: state.work.slice(-20), answer: reply.slice(0, 500) }, REVIEW))

    const flagged = Object.entries(answers).filter(([, v]) => v >= REVIEW_AT).map(([k]) => k)
    yield* ctx.session.record("review", flagged.join(", ") || "none", { scores: answers })
    yield* emit("review", ctx.depth, `review gate: ${Object.entries(answers).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ")}${flagged.length ? " → flagged" : ""}`)

    if (flagged.length) yield* (yield* Background).run(review(ctx, state, reply).pipe(Effect.ignore))
  })

// The reviewer (System Two) sees the whole turn and what's saved so far, and proposes what to keep.
const review = (ctx: Ctx, state: TurnState, reply: string) =>
  Effect.gen(function* () {
    const existing = yield* loadChecks(process.cwd())
    const digest = [
      `Project: ${process.cwd()}`,
      `Saved checks: ${existing.length ? existing.map((c) => `\n- ${c.name} (${c.scope}): ${c.template}: ${c.description}`).join("") : "none"}`,
      `Saved notes: ${(yield* (yield* Memory).snapshot) || "none"}`,
      `Goal: ${ctx.input}`,
      `What was run, in order (command → end of its output; check → System One's verdict):\n${state.work.map((w) => `- ${w}`).join("\n")}`,
      `Answer: ${reply}`,
    ].join("\n\n")

    const { result: { proposals }, ms } = yield* timed(ctx, "systemTwo", (yield* Reviewer).review(digest))

    const applied = yield* applyProposals(proposals, state.passed, process.cwd(), `reviewer in session ${ctx.session.id}`)
    yield* ctx.session.record("review", "proposals", { proposals, applied })
    yield* emit("review", ctx.depth, `reviewer (${(ms / 1000).toFixed(1)}s): ` +
      `${applied.map((a) => `\n  ${a}`).join("") || "no checks"}` +
      `${proposals.open_items.map((o) => `\n  open: ${o}`).join("")}${proposals.repeated_failures.map((f) => `\n  repeated: ${f}`).join("")}`)
  })
