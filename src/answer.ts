import { Cause, Context, Duration, Effect, Exit, Scope } from "effect"
import { Config } from "./base/config"
import { reportState } from "./integrations/herdr"
import { systemTwoServices } from "./loop/systems"
import { type Agent, applyAgent, listAgents, loadAgent } from "./base/agents"
import { SystemOne } from "./system-one/systemone"
import type { SessionHandle } from "./base/session"
import { Kernel } from "./tools/kernel-service"
import { type Totals, Usage } from "./base/usage"
import { turn } from "./loop/turn"
import { childConfig, type Conversation } from "./loop/turnkit"
import { noteStop } from "./system-two/thread"
import { saveConversation, useSystemTwo } from "./loop/resume"
import { ActiveAgent } from "./base/memory"

// Shared by the plain prompt (main.ts) and the TUI (tui.ts).

// One message end to end: the reply, followed by time and tokens for the turn and session.
// Both summaries include every sub-agent and are shown regardless of the log level.
export const answer = (session: SessionHandle, input: string, conversation: Conversation) =>
  Effect.gen(function* () {
    yield* reportState("working")

    // No job outlives the turn that started it (a run can't finish with uncollected jobs anyway): whatever is left is
    // cancelled, so nothing keeps working, or keeps a -p run from exiting, after the answer.
    const [took, reply] = yield* Effect.timed(turn(session, input, 0, conversation).pipe(
      Effect.ensuring(conversation.jobs.cancelAll),
      Effect.ensuring(reportState("idle")), // also after a failed or interrupted turn
    ))

    const usage = yield* Usage
    yield* usage.add("turn", Duration.toMillis(took), { input: 0, output: 0 })
    const { turn: thisTurn, session: sessionSoFar } = yield* usage.take
    const remembered = conversation.remembered.splice(0) // what System Two changed in memory this turn, said once

    return {
      reply,
      remembered,
      usage: [usageLine("turn   ", thisTurn), usageLine("session", sessionSoFar)],
      brief: { turn: briefLine("turn   ", thisTurn), session: briefLine("session", sessionSoFar) },
    }
  })

// Time and tokens, per system: a turn's, or a whole run's.
const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`
const tokens = (t: Totals["systemOne"]) =>
  `${t.input} in${t.cached ? ` (${t.cached} cached)` : ""} / ${t.output} out${t.thinking ? ` (${t.thinking} thinking)` : ""}`
export const usageLine = (label: string, t: Totals) =>
  `${label} ${secs(t.turn.ms)} · system 1 ${secs(t.systemOne.ms)}, ${tokens(t.systemOne)} · system 2 ${secs(t.systemTwo.ms)}, ${tokens(t.systemTwo)}` +
  (t.fill.input ? ` · fill ${secs(t.fill.ms)}, ${tokens(t.fill)}` : "")

// The same, short and always the same width (so it doesn't jump as the numbers grow): time as h:mm:ss, and tokens of
// all systems together, each 5 characters wide (999, 1.2k, 785k, 1.2M, 12M).
const clock = (ms: number) => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
}
export const short = (n: number) =>
  (n < 1000 ? `${n}` : n < 9950 ? `${(n / 1e3).toFixed(1)}k` : n < 999_500 ? `${Math.round(n / 1e3)}k` : n < 9_950_000 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e6)}M`).padStart(5)
export const briefLine = (label: string, t: Totals) => {
  const all = [t.systemOne, t.systemTwo, t.fill]
  const sum = (key: "input" | "cached" | "output") => all.reduce((n, x) => n + x[key], 0)
  return `${label} ${clock(t.turn.ms)} · ${short(sum("input"))} in · ${short(sum("cached"))} cached · ${short(sum("output"))} out`
}

// When an interactive session ends (the TUI or the plain prompt closes): how to pick it up again, as Claude Code
// shows, and what this run spent (a resumed session counts from where this run started).
export const farewell = (session: SessionHandle) =>
  Effect.gen(function* () {
    const { session: spent } = yield* (yield* Usage).take
    return [`Resume this session with: empty-vessel --resume ${session.id}`, usageLine("this run", spent)]
  })

// After Ctrl+C stopped a turn: the thread is tidied and told what happened (the stopped run may have changed files),
// and everything not yet in the session file is written (the stopped run's cells and outputs too), so a resumed
// session has what the live one had. The turn's bookkeeping is done as for a finished one: an action line (System One's turn
// numbers count them) and the turn's usage taken, so it isn't added to the next turn.
export const stopped = (session: SessionHandle, input: string, conversation: Conversation) =>
  Effect.gen(function* () {
    yield* conversation.jobs.cancelAll // its sub-agents stop too
    noteStop(conversation.thread, input)
    yield* saveConversation(session, conversation)

    conversation.actions.push("stopped by the user")
    yield* session.record("actions", "stopped by the user").pipe(Effect.ignore)
    yield* (yield* Usage).take
    yield* session.record("assistant", "(stopped)")
    return "(stopped)"
  })

// !command and !!command, typed at empty-vessel's prompt: a shell command you run yourself (bash, in the project folder, up
// to 10 minutes; stopping the turn kills it). Its output is shown to you; with one !, it's also handed to empty-vessel: an
// exchange in the conversation ("! npm test", then the output), which System One sees in its recent history and
// System Two gets with its next prompt; the session file keeps it, so a resumed session has it too. With !!, it's only
// for you.
export const SHELL_TIMEOUT_MS = 600_000
export const userCommand = (session: SessionHandle, conversation: Conversation, command: string, share: boolean) =>
  Effect.gen(function* () {
    // Run where the agent works (the kernel's world: the same files it sees), whatever the kernel grants the agent:
    // the grants are for empty-vessel's systems, and this is your own command.
    const output = yield* (yield* Kernel).exec(command, SHELL_TIMEOUT_MS).pipe(Effect.catch((e) => Effect.succeed(`the command couldn't run: ${e}`)))
    if (!share) return output

    const user = `! ${command}`
    conversation.history.push({ user, answer: output })
    conversation.unseen.push({ user, answer: output })
    yield* session.record("user", user).pipe(Effect.ignore)
    yield* session.record("assistant", output).pipe(Effect.ignore)
    return output
  })


// /model [name]: which System Two this session uses, or another plugin's for the rest of it.
// Returns the services the next turns run with: the new System Two's merged over the old, or the old ones unchanged if
// it can't be made (the reply says why), for any reason, a defect included. Not while sub-agents run: they hold the old one.
// Each switch's System Two lives in its own scope, closed when the next switch replaces it (the start-up one lives in
// the session's). modelScope: the current one, for tests.
let current: Scope.Closeable | undefined
export const modelScope = () => current

// Who owns the System Two a switch makes: each session runner (TUI, channel) has its own, so closing one session's
// model never closes another's. Without one, the module's `current` (the plain prompt).
export type ModelOwner = { current?: Scope.Closeable }

// The next turns' System Two, made from `config` in a scope of its own; `record` (writing the change down) runs once it's
// made. Any failure, a defect included, changes nothing and says why; success closes the System Two it replaces.
// An interrupted switch releases the candidate model, without closing a live one.
const replaceSystemTwo = <R, E>(config: Config["Service"], services: Context.Context<R | Config>, record: Effect.Effect<unknown, E>, owner?: ModelOwner) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    let installed = false
    return yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const made = yield* restore(systemTwoServices(config).pipe(Effect.provideService(Scope.Scope, scope), Effect.provideContext(services))).pipe(Effect.exit)
      if (Exit.isFailure(made)) {
        yield* Scope.close(scope, made)
        const why = Cause.squash(made.cause)
        return { failed: why instanceof Error ? why.message : String(why) } as const
      }

      const recorded = yield* record.pipe(Effect.exit)
      if (Exit.isFailure(recorded)) {
        yield* Scope.close(scope, recorded)
        return { failed: "the session file couldn't record the switch" } as const
      }

      const previous = owner ? owner.current : current
      if (previous) yield* Scope.close(previous, Exit.void) // the System Two this replaces, and what it held
      if (owner) owner.current = scope
      else current = scope
      installed = true
      return { services: Context.merge(services, made.value.services), describe: made.value.describe } as const
    })).pipe(Effect.ensuring(Effect.suspend(() => (installed ? Effect.void : Scope.close(scope, Exit.void)))))
  })

export const modelCommand = <R>(session: SessionHandle, conversation: Conversation, name: string, services: Context.Context<R | Config>, owner?: ModelOwner) =>
  Effect.gen(function* () {
    if (!name || name === conversation.backend) return { reply: `system two: ${conversation.backend}`, services }
    if (conversation.jobs.pending().length) return { reply: `system two stays ${conversation.backend}: sub-agents are still running on it`, services }

    const config = Context.get(services as Context.Context<Config>, Config)
    const made = yield* replaceSystemTwo({ ...config, systemTwo: { ...config.systemTwo, use: name } }, services, useSystemTwo(session, conversation, name), owner)
    if ("failed" in made) return { reply: `system two stays ${conversation.backend}: ${made.failed}`, services }
    return { reply: `system two: ${made.describe.long}, taking over from the kernel's record and the last exchanges`, services: made.services }
  })

// The conversation's agent: System One picks one for the first message, from the agents'
// descriptions, or none ("root": empty-vessel as itself, the default). Picked surely enough (the agent's confidence), the
// next turns run with its config (grants narrowed: childConfig), its System Two and its instructions, and the session
// records it. Per conversation for now: switching mid-conversation is still to be designed.
const ROOT = "None of the others fits: general work, done as empty-vessel itself"
export const pickAgent = <R>(session: SessionHandle, conversation: Conversation, input: string, services: Context.Context<R | Config | SystemOne>, home?: string, owner?: ModelOwner) =>
  Effect.gen(function* () {
    const agents = listAgents(home)
    if (!agents.length) return { services, line: undefined }

    const options = { root: ROOT, ...Object.fromEntries(agents.map((a) => [a.name, a.description || a.name])) }
    const pick = yield* Context.get(services as Context.Context<SystemOne>, SystemOne).choose({ goal: input, steps: [] }, options)
    if (pick.choice === "root" || !(pick.choice in options)) return { services, line: undefined }

    const agent = yield* loadAgent(pick.choice, home).pipe(Effect.option)
    if (agent._tag === "None" || pick.confidence < agent.value.confidence) return { services, line: undefined }
    return yield* useAgent(session, conversation, agent.value, services, `System One: ${pick.confidence.toFixed(2)}`, owner)
  })

// Work as `agent` from the next turn: its config over this one's, its System Two, its instructions, recorded.
export const useAgent = <R>(session: SessionHandle, conversation: Conversation, agent: Agent, services: Context.Context<R | Config>, why: string, owner?: ModelOwner) =>
  Effect.gen(function* () {
    const parent = Context.get(services as Context.Context<Config>, Config)
    const applied = yield* applyAgent(parent, agent).pipe(Effect.option)
    if (applied._tag === "None") return { services, line: `agent ${agent.name} doesn't make a valid config (empty-vessel doctor says why): working as empty-vessel` }

    // Its System Two is the conversation's backend from now on (recorded, so /model and a resume see it). Before the
    // first message there's no thread to hand over; on a resume it's the backend recorded already.
    const config = childConfig(parent, { agent: { ...agent, config: applied.value } })
    const use = config.systemTwo.use
    const record = Effect.gen(function* () {
      if (use !== conversation.backend) yield* session.record("systemTwo", use)
      yield* session.record("agent", agent.name)
    })
    const made = yield* replaceSystemTwo(config, services, record, owner)
    if ("failed" in made) return { services, line: `agent ${agent.name} can't start (${made.failed}): working as empty-vessel` }

    conversation.backend = use
    conversation.agent = agent.name
    conversation.instructions = agent.instructions
    // Its memory too: its own notes, read with empty-vessel's (src/base/memory.ts).
    return { services: Context.add(made.services, ActiveAgent, agent.name), line: `working as ${agent.name} (${why})` }
  })

// Before a conversation's first message: System One picks its agent, once (not for a command, or once one is set).
const started = (conversation: Conversation) => conversation.history.some((h) => !h.user.startsWith("! ")) // a shared !command isn't a message
export const firstAgent = <R>(session: SessionHandle, conversation: Conversation, input: string, services: Context.Context<R | Config | SystemOne>, owner?: ModelOwner) =>
  started(conversation) || conversation.agent || /^[/!]/.test(input) ? Effect.succeed({ services, line: undefined as string | undefined }) : pickAgent(session, conversation, input, services, undefined, owner)

// A resumed session goes on as the agent it was working as (its record), if that agent still loads; `use` is the
// System Two it goes on with (the caller compares it with the recorded one: another means a takeover).
export const resumeAgent = <R>(session: SessionHandle, conversation: Conversation, services: Context.Context<R | Config>, owner?: ModelOwner) =>
  Effect.gen(function* () {
    const name = conversation.agent
    if (!name || name === "root") return { services, line: undefined as string | undefined, use: undefined as string | undefined }

    const agent = yield* loadAgent(name).pipe(Effect.option)
    if (agent._tag === "None") return { services, line: `agent ${name} no longer loads (empty-vessel doctor says why): working as empty-vessel`, use: undefined }
    const used = yield* useAgent(session, conversation, agent.value, services, "as before", owner)
    return { ...used, use: conversation.agent === name ? conversation.backend : undefined }
  })

// /agent [name]: which agent this conversation works as; before its first message, pick one yourself (or root:
// empty-vessel as itself, and System One won't pick). Switching mid-conversation isn't built yet.
export const agentCommand = <R>(session: SessionHandle, conversation: Conversation, name: string, services: Context.Context<R | Config>, owner?: ModelOwner) =>
  Effect.gen(function* () {
    if (!name) return { services, reply: `agent: ${conversation.agent ?? "root (empty-vessel as itself)"}` }
    if (started(conversation)) return { services, reply: `this conversation works as ${conversation.agent ?? "root"}; switching mid-conversation isn't built yet` }

    if (name === "root") {
      conversation.agent = "root"
      return { services, reply: "agent: root (empty-vessel as itself)" }
    }

    const agent = yield* loadAgent(name).pipe(Effect.exit)
    if (Exit.isFailure(agent)) return { services, reply: String((Cause.squash(agent.cause) as Error).message) }
    const used = yield* useAgent(session, conversation, agent.value, services, "your pick", owner)
    return { services: used.services, reply: used.line }
  })
