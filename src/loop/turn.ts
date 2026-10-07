import { Context, Effect } from "effect"
import { reportState } from "../integrations/herdr"
import { systemTwoServices } from "./systems"
import { AgentError } from "../base/agents"
import { emit } from "../base/events"
import { Config } from "../base/config"
import { compactIfNeeded } from "./compact"
import { endTurn } from "./endturn"
import { briefing } from "../learning/notes"
import { responseStyle } from "../system-two/style"
import { projectInstructions } from "../base/context"
import { CurrentSession, SessionMirror, makeSession, type SessionError, type SessionHandle } from "../base/session"
import { systemOneTools, libraryDir, loadLibrary, loadPool, shortlist, usableWith } from "./library"
import { choose, record, settle, stats } from "./pool"
import { kernelCells } from "./adopt"
import { verdictFor, withUnclear } from "../tools/judge-rules"
import { libraryStep, OPTIONS, STEPS } from "./steps"
import { SystemOne } from "../system-one/systemone"
import { SystemTwo } from "../system-two/systemtwo"
import { TEST_OPTIONS, TEST_STEPS } from "./test-options"
import { type ChildOptions, childConfig, type Conversation, type Ctx, type Needs, newConversation, newTurnState, type Step, type StepResult, timed, type TurnState } from "./turnkit"
import { Usage } from "../base/usage"
import { ActiveAgent } from "../base/memory"

const DONE_AT = 0.5 // ponytail: fixed; tune from logged decisions once we have evals
const VETO_BELOW = 0.15 // after System Two answers, the turn ends unless System One is sure it isn't done
const SURE_AT = 0.5 // below this, System One's pick goes to System Two instead (unsure means likely wrong, e.g. repeating a failed step)
// A library pick runs a tool on the goal, so it needs more: System One (measured on Jev) is right 98% of the time at 0.95 and up, 55-76%
// between 0.5 and 0.95. Between SURE_AT and this, System One is asked once more
// (confirmPick); below SURE_AT, System Two takes the step.
const LIBRARY_SURE_AT = 0.95

// A library pick System One wasn't sure of: one yes/no question about just that tool. Two options is where System One's confidence
// is known to hold (product_matching: 100 of 106 right at 0.5 and up), and the doubt rule makes "unsure" a no.
export const confirmPick = (ctx: Ctx, description: string) =>
  Effect.gen(function* () {
    const options = { yes: "Yes: this request is exactly the kind the tool is for", no: "No, or only partly: it asks for something else or more" }
    const question = { fits: { question: `A tool is for this: "${description}". Is this request one it's for?`, options } }
    const { result } = yield* timed(ctx, "systemOne", ctx.systemOne.decide({ goal: ctx.input }, withUnclear(question)))
    const answer = result.answers.fits ?? { choice: "", confidence: 0 }
    return { fits: verdictFor(answer.choice, answer.confidence, options) === "yes", confidence: answer.confidence }
  })

// When a turn is done. Never before this turn has a reply: an answer from a step, or System Two having run (the answer
// may be in the history, but this turn owes one). Gathering or a tool that failed doesn't count: a turn that only did
// those replied "loaded …" to a question. After System Two answered: done, unless System One is sure it isn't, and a
// question for the user is never sent back (the side that knows the plan decides; it's the user's turn).
export const isFinished = (stepsSoFar: number, done: number, systemTwoAnswered: boolean, asked: boolean) => {
  const vetoed = systemTwoAnswered && done < VETO_BELOW && !asked
  return { vetoed, finished: stepsSoFar > 0 && (done >= DONE_AT || (systemTwoAnswered && !vetoed)) }
}

// The reply: an answer if any step gave one, otherwise what the last step did; noted if the step limit cut it short.
export const finalReply = (answerText: string | undefined, last: string, hitLimit: boolean) => `${answerText ?? last}${hitLimit ? " (step limit)" : ""}`

// System One's decision for the next step: is the goal done, and if not, which option. Its view stays small: what it did
// in the last 20 turns, the last 3 exchanges (long answers trimmed), the goal, and this turn's last 3 steps.
const decide = (ctx: Ctx, state: TurnState, options: Readonly<Record<string, string>>, library: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const { history, actions } = ctx.conversation
    const earlier = history.slice(-3).map((h) => `User: ${h.user} → answered: ${h.answer.length > 300 ? `${h.answer.slice(0, 300)}…` : h.answer}`)
    const recent = actions.slice(-20).map((a, i, all) => `turn ${actions.length - all.length + i + 1}: ${a}`)
    const view = { ...(recent.length ? { did: recent } : {}), ...(earlier.length ? { earlier } : {}), goal: ctx.input, steps: state.steps.slice(-3) }

    yield* emit("activity", ctx.depth, `System One is choosing step ${state.steps.length + 1}`)
    const { result: { choice: picked, confidence, done, tokens }, ms } = yield* timed(ctx, "systemOne", ctx.systemOne.choose(view, options))
    const doubtful = library.has(picked) && confidence >= SURE_AT && confidence < LIBRARY_SURE_AT
    const confirmed = doubtful ? yield* confirmPick(ctx, options[picked]!) : undefined
    const choice = confidence < SURE_AT || (library.has(picked) && confidence < LIBRARY_SURE_AT && !confirmed?.fits) ? "escalate" : picked

    // Verbose (--log-level debug): exactly what System One saw and answered, and its cost.
    yield* Effect.logDebug(`system one (${Math.round(ms)} ms)`, { depth: ctx.depth, state: view, choice, confidence, done, tokens })
    yield* ctx.session.record("decision", choice, { confidence, done, ...(choice !== picked ? { systemOnePicked: picked } : {}), ...(confirmed ? { confirmed } : {}) })

    const { vetoed, finished } = isFinished(state.answerText !== undefined || state.escalated > 0 ? state.steps.length : 0, done, state.systemTwoAnswered, state.answerText?.trim().endsWith("?") ?? false)
    if (vetoed) yield* emit("step", ctx.depth, `System One: not done yet (${done.toFixed(2)}), System Two continues`)
    state.systemTwoAnswered = false

    yield* emit("step", ctx.depth, `step ${state.steps.length + 1}: ${finished ? "done" : choice}${choice !== picked && !finished ? ` (System One unsure of ${picked}: ${confidence.toFixed(2)})` : ""}${confirmed?.fits && !finished ? ` (${confidence.toFixed(2)}, confirmed yes ${confirmed.confidence.toFixed(2)})` : ""} (done ${done.toFixed(2)})`)
    return { choice, finished }
  })

// A step's result goes into the turn: an answer is kept (later steps can't replace it), and the step line is recorded.
const recordStep = (ctx: Ctx, state: TurnState, choice: string, result: StepResult) =>
  Effect.gen(function* () {
    if (result.answer || result.outcome === "waiting_for_user") state.answerText = result.reply
    state.systemTwoAnswered = result.fromSystemTwo === true

    const step = `${choice} → ${result.outcome}: ${result.reply}`
    state.steps.push(step)
    yield* ctx.session.record("step", step) // the full result of this step, for debugging
  })

// One agent turn, the same for the root and every sub-agent: record the input, then ask System One and run one step
// at a time until the goal is done, then record the reply and end the turn (review gate, reviewer).
export const turn = (session: SessionHandle, input: string, depth: number, conversation: Conversation): Effect.Effect<string, SessionError, Needs> =>
  Effect.gen(function* () {
    const systemTwo = yield* SystemTwo
    return yield* runTurn(session, input, depth, conversation).pipe(
      Effect.provideService(CurrentSession, session),
      // Explicitly reset for a child using another provider; never inherit its parent's exporter.
      Effect.provideService(SessionMirror, systemTwo.sessionMirror ?? (() => Effect.void)),
    )
  })

const runTurn = (session: SessionHandle, input: string, depth: number, conversation: Conversation): Effect.Effect<string, SessionError, Needs> =>
  Effect.gen(function* () {
    yield* session.record("user", input)

    // What the loop hands System Two with every request, worked out once: the project's AGENTS.md / CLAUDE.md, then what
    // empty-vessel learned about the project (notes, saved checks), then how to shape what it writes to the user
    // (systemTwo.style). Every backend gets it the same way.
    if (conversation.briefing === undefined) {
      const style = responseStyle((yield* Config).systemTwo.style)
      const parts = [yield* projectInstructions(process.cwd()).pipe(Effect.orElseSucceed(() => "")), yield* briefing(process.cwd()), style]
      conversation.briefing = [...parts, conversation.instructions].filter(Boolean).join("\n\n") // an agent's instructions last
    }

    const config = yield* Config
    const ctx: Ctx = {
      session, input, depth, conversation, config,
      systemOne: yield* SystemOne, systemTwo: yield* SystemTwo, usage: yield* Usage,
      spawn: (child, options) => spawn(session, child, depth + 1, options, conversation.instructions),
    }

    yield* compactIfNeeded(ctx)

    // System One's options: its own, plus the library tools on this turn's shortlist and those System Two handed it this
    // session (read each step: System Two may hand some over while it has the item).
    const dir = libraryDir(process.cwd())
    // The pool settles first (graduating or dropping trial tools); then System One's options come from the library's System One tools.
    const known = stats(dir) // the adoption record, read once this turn
    const settled = yield* settle(dir, config.adoption, session.id, conversation.history.length + 1, known)
    for (const e of settled.graduated) yield* emit("review", depth, `adoption: ${e.name} graduated into the library (for ${e.for === "systemOne" ? "System One" : "System Two"})`)
    for (const e of settled.dropped) yield* emit("review", depth, `adoption: ${e.name} dropped from the pool`)

    const usable = usableWith(config.kernel.tools) // tools needing a built-in this kernel doesn't grant aren't offered
    const promoted = systemOneTools(loadLibrary(dir)).filter(usable)
    const library = new Set(promoted.map((e) => e.name))
    const { result: short } = yield* timed(ctx, "systemOne", shortlist(ctx.systemOne, input, promoted, conversation.tools))
    if (promoted.length) yield* session.record("shown", short.shown.map((e) => e.name).join(", "), { of: promoted.length, scores: short.scores })

    // Pool tools on trial (adoption, src/loop/pool.ts): a few for each system, chosen by the sampler; System One's go straight
    // into its options, past the shortlist, and System Two's into its prompt. Each offer is recorded.
    const state = newTurnState()
    state.cellsBefore = kernelCells(session.dir).length
    state.turn = conversation.history.length + 1
    const pool = loadPool(dir).filter(usable)
    const trial = (kind: "systemOne" | "systemTwo", n: number) => choose(pool.filter((e) => e.for === kind), known, n, config.adoption.sampler, config.adoption.reward)
    const trialSystemOne = trial("systemOne", config.adoption.offerSystemOne)
    state.offered = { systemOne: trialSystemOne.map((e) => e.name), systemTwo: trial("systemTwo", config.adoption.offerSystemTwo).map((e) => e.name) }
    for (const kind of ["systemOne", "systemTwo"] as const) for (const tool of state.offered[kind]) record(dir, { session: session.id, turn: state.turn, tool, for: kind, event: "offered" })
    for (const e of trialSystemOne) library.add(e.name) // the 0.95 bar and the confirmation apply to them too

    const base = config.testOptions ? { ...TEST_OPTIONS, ...OPTIONS } : OPTIONS
    const optionsNow = () => {
      // A tool already run this turn isn't offered again: on the same request it gives the same result (System One
      // picked one 6 times in a row when its answer didn't fit).
      const shown = [...short.shown, ...promoted.filter((e) => conversation.tools.has(e.name) && !short.shown.includes(e)), ...trialSystemOne].filter((e) => !state.did.includes(e.name))
      return { ...base, ...Object.fromEntries(shown.map((e) => [e.name, e.description])) }
    }
    const steps: Readonly<Record<string, Step>> = { ...(config.testOptions ? { ...TEST_STEPS, ...STEPS } : STEPS), ...Object.fromEntries([...promoted, ...trialSystemOne].map((e) => [e.name, libraryStep(e.name, dir)])) }

    let last = "", finishedByCheck = false, waitingForUser = false

    while (state.steps.length < config.maxSteps) {
      const { choice, finished } = yield* decide(ctx, state, optionsNow(), library)
      if (finished) break

      const result = yield* (steps[choice] ?? STEPS.escalate!)(ctx, state) // a pick with no step (e.g. the fake's "ask") goes to System Two
      yield* recordStep(ctx, state, choice, result)
      last = result.reply
      finishedByCheck = result.finishedByCheck === true
      waitingForUser = result.outcome === "waiting_for_user"
      if (depth === 0 && waitingForUser) yield* reportState("blocked")

      // A human checkpoint ends this turn before System One can retry the unfinished goal.
      if (finishedByCheck || waitingForUser) break
    }

    const hitLimit = state.steps.length === config.maxSteps && !finishedByCheck && !waitingForUser
    const reply = finalReply(state.answerText, last, hitLimit)

    yield* session.record("assistant", reply)
    yield* endTurn(ctx, state, reply)
    return reply
  })

// A sub-agent: fresh session inside the parent's folder, one turn. Only its reply goes back.
// The parent's file records what it sent and what came back, with the child's id as the link.
// As an agent: its config (childConfig), its instructions after the project's, and its own System Two when it sets
// another backend or plugin settings, made for this turn and closed after it (src/loop/systems.ts, as /model does).
// Without an agent of its own, a child works as its parent's (its config and System Two come with the context; its
// instructions are `inherited`).
const spawn = (parent: SessionHandle, input: string, depth: number, options: ChildOptions = {}, inherited?: string): Effect.Effect<string, SessionError | AgentError, Needs> =>
  Effect.gen(function* () {
    const config = childConfig(yield* Config, options)
    const { agent } = options
    const session = yield* makeSession(parent.key)
    yield* emit("spawn", depth, `depth ${depth}: session ${session.id}${agent ? ` as ${agent.name}` : ""}`)
    yield* parent.record("spawn", input, { child: session.id, ...(agent ? { agent: agent.name } : {}) })

    const conversation = newConversation() // a child has its own memory: only its result comes back
    const instructions = agent ? agent.instructions : inherited
    if (instructions) conversation.instructions = instructions
    // No job outlives the agent that started it: when this sub-agent's turn ends (or is stopped), so do its sub-agents.
    const run = turn(session, input, depth, conversation).pipe(Effect.ensuring(conversation.jobs.cancelAll), Effect.provideService(Config, config),
      (e) => (agent ? Effect.provideService(e, ActiveAgent, agent.name) : e)) // its memory, as its agent
    const ownSystemTwo = agent && ("systemTwo" in agent.settings || "plugins" in agent.settings)
    const reply = ownSystemTwo
      ? yield* Effect.scoped(Effect.gen(function* () {
        // Can't be made (no login, a plugin that won't load): the job fails with that, in a line.
        const { services } = yield* systemTwoServices(config).pipe(Effect.mapError((e) => new AgentError({ message: `agent ${agent.name}: its System Two can't be made: ${e.message}` })))
        return yield* run.pipe(Effect.provideContext(Context.merge(yield* Effect.context<Needs>(), services)))
      }))
      : yield* run

    yield* parent.record("result", reply, { child: session.id })
    return reply
  })
