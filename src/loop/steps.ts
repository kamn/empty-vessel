import { mkdirSync } from "node:fs"
import { Effect } from "effect"
import { AskUser } from "../ui/ask"
import type { AskUserArgs } from "../system-two/systemtwo"
import { loadChecks } from "../learning/checks"
import { explore, packFiles } from "../system-one/explore"
import { Kernel } from "../tools/kernel-service"
import { emit } from "../base/events"
import { makeHost, makeKernelHook } from "./kernel"
import { helpers, systemOneTools, libraryDir, loadLibrary, loadPool, pickCell, writeBuiltins, usableWith } from "./library"
import { imagesIn } from "../base/images"
import { record } from "./pool"
import { kernelSources, sourcesLine } from "./sources"
import { makeHandoff, makeOnCommand } from "./handoff"
import { makePrune } from "./prune"
import { PRUNE_OVER } from "../system-two/dispatch"
import { remember } from "./resume"
import { scopeNote, watchScope } from "./scope"
import { Inbox } from "../base/inbox"
import { listAgents } from "../base/agents"
import { Memory } from "../base/memory"
import { type Conversation, type Ctx, type Exchange, type Needs, type Step, timed } from "./turnkit"

// What System One can pick each step. The descriptions are what System One reads to choose, so wording matters.
export const OPTIONS = {
  // Describes the history ("tried?"), not the situation ("loaded?"): a failed gather leaves files unloaded, but trying again gives the same result.
  gather: "The goal is about files in this project, and gathering hasn't been tried yet in this turn",
  escalate: "Needs real thinking: a question, or anything no other option covers",
}

// Turns System One answered alone, for System Two's next prompt. A long answer is shortened the way long command output
// is (System One hides what doesn't help the goal); the full text goes in the stash, for more_output.
export const handOver = (unseen: ReadonlyArray<Exchange>, prune: (label: string, output: string) => Effect.Effect<string>, stash: Map<string, string>) =>
  Effect.gen(function* () {
    if (!unseen.length) return ""
    const parts: Array<string> = []

    for (const h of unseen) {
      // A command you ran at the prompt (!command, src/answer.ts): its output, as yours, not System One's answer.
      if (h.user.startsWith("! ")) {
        parts.push(`You ran \`${h.user.slice(2)}\` in the terminal. Output:\n${h.answer.length > PRUNE_OVER ? `${h.answer.slice(0, PRUNE_OVER)}\n[…]` : h.answer}`)
        continue
      }
      const shorter = h.answer.length > PRUNE_OVER ? yield* prune(`System One's answer to "${h.user}"`, h.answer) : h.answer
      if (shorter.length >= h.answer.length) {
        parts.push(`User: ${h.user}\nAnswer: ${h.answer}`)
        continue
      }

      const id = `out${stash.size + 1}`
      stash.set(id, h.answer)
      parts.push(`User: ${h.user}\nAnswer: ${shorter}\n[System One shortened this answer. If you need the hidden parts: more_output { id: "${id}" }]`)
    }

    // With a command of yours among them, System One's answers are named as its own; without, the usual heading.
    return unseen.some((h) => h.user.startsWith("! "))
      ? `Since your last answer:\n\n${parts.join("\n\n").replace(/^Answer: /gm, "System One's answer: ")}`
      : `Since your last answer, System One handled these on its own:\n\n${parts.join("\n\n")}`
  })

// The agents a sub-agent can work as (src/base/agents.ts), for System Two's first prompt: only when there are some and
// this agent may still spawn (the agents grant, and depth left).
export const agentsLine = (ctx: Pick<Ctx, "depth" | "config">, home?: string) => {
  if (!ctx.config.kernel.tools.agents || ctx.depth >= ctx.config.maxDepth) return undefined
  const agents = listAgents(home)
  if (!agents.length) return undefined
  return `Agents (spawn(task, { agent: name }) runs a sub-agent as one): ${agents.map((a) => `${a.name}${a.description ? ` — ${a.description}` : ""}`).join("; ")}`
}

// What System Two is told once, on its next run: a resumed session's cells from before the kernel's rules, and the
// takeover note when System Two changed (resume.ts). Taken from the conversation, so they aren't told twice.
export const onceNotes = (conversation: Conversation) => {
  const notes = [conversation.olderCells, conversation.takeover].filter((n): n is string => n !== undefined)
  delete conversation.olderCells
  delete conversation.takeover
  return notes
}

// System Two works on the goal. The thread already holds the earlier conversation (with every command and output),
// so it's only told what's new: the goal and gathered files once per turn, then the steps since it last answered.
const escalate: Step = (ctx, state) =>
  Effect.gen(function* () {
    state.did.push("escalate")
    // Images in the user's message: sent with the first run's prompt, shown in its text by their labels.
    const attached = state.escalated === 0 ? imagesIn(ctx.input, process.cwd()) : { images: [], text: ctx.input }
    for (const i of attached.images) yield* emit("step", ctx.depth, `  ${i.label} attached: ${i.path}`)
    const everything = loadLibrary(libraryDir(process.cwd())).filter(usableWith(ctx.config.kernel.tools))
    const library = systemOneTools(everything).map((e) => e.name)
    const helperNames = helpers(everything).map((e) => e.name)
    const outside = state.escalated === 0 ? yield* sourcesLine : "" // the tool sources and their tools' names
    const unseen = state.escalated === 0 ? ctx.conversation.unseen.splice(0) : []
    const once = state.escalated === 0 ? onceNotes(ctx.conversation) : []
    const agents = state.escalated === 0 ? agentsLine(ctx) : undefined
    const handed = yield* handOver(unseen, makePrune(ctx), ctx.conversation.stash)
    const prompt = [
      ...(handed ? [handed] : []),
      ...once,
      ...(state.escalated === 0 ? [`Goal: ${attached.text}`] : ["The goal isn't done yet. What happened since your last answer:"]),
      ...(state.escalated === 0 && attached.images.length ? [`Images attached to this message (you can see them): ${attached.images.map((i) => `${i.label} ${i.path}`).join(", ")}`] : []),
      ...(state.escalated === 0 && state.gathered ? [`System One loaded these files for you (read others if you need them):\n\n${state.gathered}`] : []),
      // Only the names: System Two loads one when it needs it (import it from "kernel"; tools() says what each is for).
      ...(state.escalated === 0 && state.offered.systemTwo.length ? [`Tools on trial (new, being tried out: import from "kernel" if one helps; tools() says how to call each): ${state.offered.systemTwo.join(", ")}`] : []),
      ...(state.escalated === 0 && outside ? [outside] : []),
      ...(state.escalated === 0 && agents ? [agents] : []),
      ...(state.escalated === 0 && helperNames.length ? [`Helpers (import from "kernel"; tools() says how to call each): ${helperNames.join(", ")}`] : []),
      ...(state.escalated === 0 && library.length ? [`Library tools (import from "kernel"; each takes the user's request as a string, e.g. ${library[0]}(request); tools() says what each does; handTools(names) gives them to System One): ${library.join(", ")}`] : []),
      ...state.steps.slice(state.told).map((s, i) => `Step ${state.told + i + 1}: ${s}`),
    ].join("\n\n")

    state.escalated++
    state.told = state.steps.length
    yield* Effect.logDebug("system two prompt", { depth: ctx.depth, prompt })

    const checks = yield* loadChecks(process.cwd())
    const user = yield* AskUser
    // Only the root agent can take over the interactive input.
    const askUser = ctx.depth === 0
      ? (args: typeof AskUserArgs.Type) => user.ask(args.questions).pipe(Effect.map((answers) => JSON.stringify(answers)))
      : undefined

    // What the turn has changed so far, so its changes reaching another part of the project can be told (src/loop/scope.ts).
    const { scopeCheck, progressMinutes } = ctx.config.systemTwo
    if (scopeCheck) yield* watchScope(state, ctx.input)

    // What you type while it works reaches the root's System Two mid-run, and the session keeps it (src/base/inbox.ts).
    const { take } = yield* Inbox
    const inbox = Effect.gen(function* () {
      const said = take()
      for (const text of said) yield* ctx.session.record("steer", text).pipe(Effect.ignore)
      return said
    })

    // What memory holds now, so a setup lesson already kept isn't suggested again (only where System Two can save one).
    const memory = yield* Memory
    const remembered = ctx.config.kernel.tools.library ? { remembered: () => memory.snapshot } : {}

    const hooks = {
      askUser, progressEveryMs: progressMinutes * 60_000, ...remembered, ...(scopeCheck ? { scope: () => scopeNote(state).pipe(Effect.tap((note) => (note ? ctx.session.record("scope", note).pipe(Effect.ignore) : Effect.void))) } : {}), ...(ctx.depth === 0 ? { inbox } : {}),
      handoff: makeHandoff(ctx, state, checks), onCommand: makeOnCommand(ctx, state), prune: makePrune(ctx),
      kernel: makeKernelHook(ctx, yield* Effect.context<Needs>(), state.offered.systemTwo, state.turn),
      grants: ctx.config.kernel.tools, // System Two is told only of the built-ins this kernel grants
      images: attached.images, thread: ctx.conversation.thread, briefing: ctx.conversation.briefing, stash: ctx.conversation.stash, cacheKey: ctx.session.id, depth: ctx.depth, pending: () => ctx.conversation.jobs.pending(),
    }

    const { result: answer } = yield* timed(ctx, "systemTwo", ctx.systemTwo.ask(prompt, hooks))
    if (answer.size) ctx.conversation.size = answer.size // how big the thread is now: compaction's trigger
    yield* remember(ctx) // into the session file, for resuming
    const failed = answer.text.startsWith("(System Two failed")
    // wait_for_user must reach the turn loop as its own outcome, or System One (goal not done) sends System Two straight back.
    const outcome = failed ? "failed" : answer.waitingForUser ? "waiting_for_user" : "ok"
    return { reply: answer.text, outcome, answer: !failed, fromSystemTwo: !failed, finishedByCheck: answer.done === true }
  })

// System One explores the project (best-first: System One scores folders and files, code opens the most promising);
// the files it picked go into System Two's first prompt, except ones already in its thread from an earlier turn.
const gather: Step = (ctx, state) =>
  Effect.gen(function* () {
    // Gather reads the project, so it needs the kernel's files (read-only is enough); without them, System One looks at nothing.
    if (ctx.config.kernel.tools.files === "none") return { reply: "This kernel grants no file access (kernel.tools.files is none): nothing to gather.", outcome: "failed" }
    const given = ctx.conversation.files
    const { result: found, ms } = yield* timed(ctx, "systemOne", explore(process.cwd(), ctx.input))

    const fresh = found.picked.filter((p) => !given.has(p))
    fresh.forEach((p) => given.add(p))
    for (const p of fresh) yield* ctx.session.record("given", p).pipe(Effect.ignore)
    state.gathered = yield* packFiles(process.cwd(), fresh)

    yield* Effect.logDebug(`system one gather (${Math.round(ms)} ms) ${JSON.stringify({ calls: found.calls, picked: found.picked })}`)
    state.did.push(`gather (${found.picked.map((p) => p.split("/").at(-1)).join(", ") || "nothing"})`)

    if (found.picked.length) {
      const earlier = found.picked.filter((p) => !fresh.includes(p))
      return { reply: `loaded ${fresh.join(", ") || "nothing new"}${earlier.length ? ` (already loaded earlier: ${earlier.join(", ")})` : ""}`, outcome: "ok" }
    }

    // Say what was actually looked at, not a conclusion: "nothing found" ≠ "no files are needed".
    return { reply: `explored with ${found.calls} System One calls and found no relevant files; last moves: ${found.moves.slice(-3).map((m) => m.slice(0, 120)).join("; ")}`, outcome: "failed" }
  })

export const STEPS: Readonly<Record<string, Step>> = { escalate, gather }

// A library pick: System One's own kernel runs the promoted definition on the goal, no LLM.
// Its value is the reply; if it fails, the next step (usually escalate) sees why.
// A tool's value that answers nothing: empty, or a command's bare "exit N" with no output. It ran without error, but
// that isn't an answer: counted as a success, the trial would reward a tool for not crashing (the recurring benchmark:
// a locale tool's "exit 0 (no output)" was given as the answer and counted as it working).
export const saysNothing = (value: unknown) => {
  const text = (typeof value === "string" ? value : JSON.stringify(value) ?? "").trim()
  return ["", "null", "[]", "{}", '""'].includes(text) || /^exit \d+\s*(\(no output\))?$/.test(text)
}

export const libraryStep = (name: string, dir: string): Step => (ctx, state) =>
  Effect.gen(function* () {
    state.did.push(name)
    mkdirSync(`${ctx.session.dir}/kernel-one`, { recursive: true })
    const g = ctx.config.kernel.tools
    const kernel = (yield* Kernel).open({ dir: `${ctx.session.dir}/kernel-one`, builtins: writeBuiltins(`${ctx.session.dir}/kernel-one/builtins.ts`, dir, g), sources: g.sources ? kernelSources() : [] })
    const host = makeHost(ctx, yield* Effect.context<Needs>())

    // A tool with parameters gets them filled from the request; one that can't be filled isn't run.
    const parameters = [...loadLibrary(dir), ...loadPool(dir)].find((e) => e.name === name)?.parameters
    const filled = parameters ? ((yield* host.fill!({ name, parameters, request: ctx.input }).pipe(Effect.orElseSucceed(() => undefined))) as { args: Record<string, string>; missing: ReadonlyArray<string> } | undefined) : undefined
    if (parameters) yield* emit("step", ctx.depth, `  system one filled ${name}: ${filled && !filled.missing.length ? JSON.stringify(filled.args) : `missing ${(filled?.missing ?? Object.keys(parameters)).join(", ")}`}`)

    if (parameters && (!filled || filled.missing.length)) {
      if (state.offered.systemOne.includes(name)) record(dir, { session: ctx.session.id, turn: state.turn, tool: name, for: "systemOne", event: "used", ok: false })
      return { reply: `${name} wasn't run: the request doesn't say its ${(filled?.missing ?? Object.keys(parameters)).join(", ")}`, outcome: "failed" }
    }

    const r = yield* kernel.run(pickCell(name, ctx.input, filled?.args), host)

    const empty = r.status === "ok" && saysNothing(r.value)
    yield* emit("step", ctx.depth, `  system one ran ${name}: ${empty ? "no answer" : r.status}`)
    if (state.offered.systemOne.includes(name)) record(dir, { session: ctx.session.id, turn: state.turn, tool: name, for: "systemOne", event: "used", ok: r.status === "ok" && !empty })
    if (r.status !== "ok") return { reply: `${name} ${r.status}: ${r.summary.slice(0, 1000)}`, outcome: "failed" }
    if (empty) return { reply: `${name} ran but gave no answer (${String(r.value).slice(0, 100) || "empty"})`, outcome: "failed" }
    return { reply: typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 1), outcome: "ok", answer: true }
  })
