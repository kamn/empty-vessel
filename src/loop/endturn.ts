import { Context, Effect } from "effect"
import { emit } from "../base/events"
import { Background } from "../base/background"
import { withLock } from "../base/files"
import { logEntries } from "../base/session"
import { Store } from "../base/store"
import { loadChecks } from "../learning/checks"
import { Memory } from "../base/memory"
import { applyProposals, curateMemory, Reviewer } from "../learning/reviewer"
import { Timers } from "./jobs"
import { countTurn, learningSignals, NO_WINDOW, type TurnReport, type Window } from "./signals"
import { askAfterTurn, shouldAsk } from "./adopt"
import { type Ctx, timed, type TurnState, unseenBySystemTwo } from "./turnkit"

// After a turn in which System Two worked, System One decides whether it's worth a review (the reviewer is the expensive part).
const REVIEW = {
  tooling: { question: "Did the agent need failed attempts before a command or check worked?", yes: "Something only worked after failing first", no: "Everything worked on the first try" },
  repeats: { question: "Did the same command or check fail more than once?", yes: "Something failed more than once", no: "No repeated failures" },
  open: { question: "Does the answer mention something left undone or out of scope?", yes: "Something was left open", no: "Everything asked for was done" },
}
const REVIEW_AT = 0.5
// Memory nudges' one System One question per user turn (KTD18).
const CORRECTION = { corrected: { question: "Does this message correct the agent's earlier answer or approach?", yes: "It corrects or redirects what the agent said or did", no: "It's a new request, a follow-up, or thanks" } }

// Where a user turn's report goes: the background agent's worker sends it with the reply (the agent counts it and
// queues the review run, KTD18). Without the agent (the plain TUI, -p) it's counted here, in the home's nudge.json.
export const TurnReports = Context.Reference<{ readonly report?: (report: TurnReport) => Effect.Effect<void> }>("empty-vessel/TurnReports", { defaultValue: () => ({}) })
const NUDGES = "nudge.json"
const windowOf = (text: string | undefined): Window => { try { return { ...NO_WINDOW, ...JSON.parse(text ?? "") } } catch { return NO_WINDOW } }

// The end of a turn: remember what System One did, then (if System Two worked) System One's review gate, and the reviewer in the
// background for a flagged turn (the answer doesn't wait for it; empty-vessel waits before exiting, see Background).
export const endTurn = (ctx: Ctx, state: TurnState, reply: string) =>
  Effect.gen(function* () {
    const did = state.did.join(" · ") || "nothing (done straight away)"
    ctx.conversation.actions.push(did)
    yield* ctx.session.record("actions", did).pipe(Effect.ignore) // for resuming
    if (unseenBySystemTwo(state.steps.at(-1))) ctx.conversation.unseen.push({ user: ctx.input, answer: reply })
    yield* nudge(ctx, state, reply).pipe(Effect.ignore) // before the returns below: a turn System One answered alone counts too

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

// A memory nudge's count (KTD18): only a user's own turn (not a job's, a detached sub-agent's, or a sub-agent's) counts.
// Its report: one turn, its tool calls, its learning signals, and whether the message corrected the agent (asked only
// when there was an earlier answer to correct).
const nudge = (ctx: Ctx, state: TurnState, reply: string) =>
  Effect.gen(function* () {
    const origin = (yield* Timers).origin()
    if (!ctx.config.nudges || ctx.depth > 0 || (origin ?? "user") !== "user") return

    const earlier = ctx.conversation.history.at(-1)
    const asked = earlier && (yield* timed(ctx, "systemOne", ctx.systemOne.judge({ earlier: `User: ${earlier.user.slice(0, 500)} → answered: ${earlier.answer.slice(0, 500)}`, message: ctx.input.slice(0, 1000) }, CORRECTION))).result.answers
    const store = yield* Store
    const signals = learningSignals(logEntries(yield* store.get(`${ctx.session.key}/main.jsonl`)))
    const report: TurnReport = { userTurns: 1, toolIterations: state.work.length, signals, corrected: (asked?.corrected ?? 0) >= REVIEW_AT }

    const agent = (yield* TurnReports).report
    if (agent) return yield* agent(report)

    // No agent: the window is the home's (a new session doesn't reset it), and its review runs in the background.
    const review = yield* withLock(store.folder(NUDGES), Effect.gen(function* () {
      const counted = countTurn(windowOf(yield* store.get(NUDGES)), report)
      yield* store.put(NUDGES, JSON.stringify(counted.window))
      return counted.review
    }))
    if (!review) return

    const exchanges = [...ctx.conversation.history, { user: ctx.input, answer: reply }]
    yield* (yield* Background).run(curateMemory(review, exchanges).pipe(
      Effect.flatMap((said) => emit("review", ctx.depth, `memory review: ${said.map((s) => `\n  ${s}`).join("") || "nothing changed"}`)),
      Effect.ignore,
    ))
  })
