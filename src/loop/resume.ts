import { isTree } from "./checkpoint"
import { readFileSync } from "node:fs"
import { Effect } from "effect"
import { type LogEntry, logEntries, type SessionHandle } from "../base/session"
import { fromSaved, toSaved } from "../base/images"
import { type Conversation, type Ctx, newConversation, unseenBySystemTwo } from "./turnkit"
import { type Cell, underRules } from "../kernel/kernel"
import { type CallState, callTool, saveCall, shownAs } from "../system-two/dispatch"
import { userItem } from "../system-two/loop"
import type { Hooks } from "../system-two/systemtwo"

// Rebuild a conversation from its session file, to resume it: System One's history (user → assistant), its action lines,
// the files System Two was given, the stash, library tools handed to System One, System Two's thread (the last
// compaction's snapshot, then every item added after it), and the turns System Two hasn't heard about yet.
export const loadConversation = (dir: string): Conversation => {
  const c = newConversation()
  let user = "", lastStep: string | undefined, switched = false

  // A line cut short (the process killed mid-append) is skipped: one torn line mustn't make every resume fail.
  for (const e of logEntries(readFileSync(`${dir}/main.jsonl`, "utf8"))) {
    if (e.role === "user") {
      user = e.text
      lastStep = undefined
    }
    else if (e.role === "step") {
      lastStep = e.text
      if (!unseenBySystemTwo(lastStep)) c.unseen.length = 0 // System Two ran: it was handed them
    }
    else if (e.role === "assistant") {
      c.history.push({ user, answer: e.text })
      if (unseenBySystemTwo(lastStep) && e.text !== "(stopped)") c.unseen.push({ user, answer: e.text }) // as live: a stop isn't news
    }
    else if (e.role === "actions") c.actions.push(e.text)
    else if (e.role === "given") c.files.add(e.text)
    else if (e.role === "stash") c.stash.set(e.text, e.output)
    else if (e.role === "thread") {
      c.thread.push(fromSaved(e.item))
      // System Two ran, so it was handed what it hadn't seen (as live, steps.ts), even if the run was stopped before
      // its step line was written.
      c.unseen.length = 0
      lastStep = "escalate →"
    }
    else if (e.role === "compact" && e.thread) c.thread.splice(0, c.thread.length, ...e.thread.map(fromSaved))
    else if (e.role === "size") c.size = Number(e.text)
    else if (e.role === "tools") c.tools.add(e.text)
    else if (e.role === "checkpoint" && isTree(e.text) && isTree(e.after)) (c.checkpoints ??= []).push({ root: e.root, before: e.text, after: e.after, input: e.input, ...(e.shared === true ? { shared: true } : {}) }) // /undo's (src/loop/checkpoint.ts)
    else if (e.role === "undone") c.checkpoints?.splice(Number(e.text))
    else if (e.role === "skill" && typeof e.text === "string" && typeof e.content === "string") {
      c.activeSkills ??= Object.create(null)
      c.activeSkills![e.text] = e.content
      c.activeSkillsPending = true
    }
    else if (e.role === "agent") c.agent = e.text // the agent this conversation works as (src/answer.ts, useAgent)
    else if (e.role === "systemTwo") {
      if (c.backend && c.backend !== e.text) { c.thread.length = 0; c.size = undefined; switched = true } // another backend took over: its thread starts here
      c.backend = e.text
    }
  }

  c.saved = { thread: c.thread.length, stash: c.stash.size } // all of it came from the file
  c.olderCells = olderCellsNote(dir)
  if (switched && !c.thread.length) c.takeover = takeoverNote(dir, c) // the new System Two hasn't run yet: it still needs the note
  return c
}

// Write what isn't in the session file yet: thread items and outputs System One hid since the last save, and the
// thread's size. After every System Two run, and after a stop (Ctrl+C), which otherwise lost the stopped run's work
// from the file: a resumed session didn't have it.
export const saveConversation = (session: SessionHandle, conversation: Conversation) =>
  Effect.gen(function* () {
    const { thread, stash, size, saved } = conversation
    for (const item of thread.slice(saved.thread)) yield* session.record("thread", "", { item: toSaved(item) })
    for (const [id, output] of [...stash].slice(saved.stash)) yield* session.record("stash", id, { output })
    if (size) yield* session.record("size", String(size))
    conversation.saved = { thread: thread.length, stash: stash.size }
  }).pipe(Effect.ignore)

export const remember = (ctx: Ctx) => saveConversation(ctx.session, ctx.conversation)

// Cells a resumed session made before the kernel's rules: their definitions stay out of
// new cells' scope (loading them could do work). Resuming says how many, and System Two is shown what each defined and
// returned (its summary, as it saw it then), so the earlier work isn't lost: it can redefine what it still needs.
const okCells = (dir: string): ReadonlyArray<Cell> => {
  try { return (JSON.parse(readFileSync(`${dir}/kernel/index.json`, "utf8")) as ReadonlyArray<Cell>).filter((c) => c.status === "ok") } catch { return [] }
}
const olderCells = (dir: string) => okCells(dir).filter((c) => !underRules(c) && c.defines.length)
export const cellsBeforeRules = (dir: string) => olderCells(dir).length

// The newest of `items` that fit in `budget` characters (joined by `sep`), in order, and how many earlier ones didn't.
const takeWithinBudget = (items: ReadonlyArray<string>, budget: number, sep: string) => {
  const kept: Array<string> = []
  for (const item of [...items].reverse()) { if (kept.join(sep).length + item.length > budget) break; kept.unshift(item) }
  return { kept, left: items.length - kept.length }
}

// Cells' summaries as System Two saw them, under a heading: the latest first, if they don't all fit.
const EACH = 400, ALL = 4000 // characters of each cell's summary, and of the whole note
const cellsNote = (cells: ReadonlyArray<Cell>, heading: string) => {
  const lines = cells.map((c) => `cell ${c.n}:\n${c.summary.length > EACH ? `${c.summary.slice(0, EACH)}…` : c.summary}`)
  const { kept, left } = takeWithinBudget(lines, ALL, "\n")

  return [heading, ...(left ? [`(${left} earlier cell${left === 1 ? "" : "s"} not shown)`] : []), ...kept].join("\n\n")
}
const cellCount = (n: number) => `${n} cell${n === 1 ? "" : "s"}`

export const olderCellsNote = (dir: string) => {
  const cells = olderCells(dir)
  return cells.length ? cellsNote(cells, `This session's kernel has ${cellCount(cells.length)} from before the kernel's rules. New cells can't import their definitions: redefine what you still need (under the rules). What they defined and returned then:`) : undefined
}

// The kernel's record of the work so far, for a model taking over the session: every cell
// that ran under the rules, what it defined and returned (older cells have their own note, above). Their definitions
// are already in scope for the new model's cells.
export const kernelBriefing = (dir: string) => {
  const cells = okCells(dir).filter(underRules)
  return cells.length ? cellsNote(cells, `This session's kernel already has ${cellCount(cells.length)} that ran. Their definitions are yours to import ("kernel"); results are result(n). What each defined and returned:`) : undefined
}

// What a new System Two is told when it takes over a session: the kernel's record and the last
// few exchanges, from the session's own record (no model call, whatever the old backend was). Turns still in `unseen`
// (the latest ones) are left out: the hand-over carries them.
const RECENT = 3, ANSWER = 600 // exchanges, and characters of each answer
export const takeoverNote = (dir: string, conversation: Conversation) => {
  const { history, unseen } = conversation
  const recent = history.slice(0, history.length - unseen.length).slice(-RECENT)
  const exchanges = recent.map((h) => `User: ${h.user}\nAnswer: ${h.answer.length > ANSWER ? `${h.answer.slice(0, ANSWER)}…` : h.answer}`)
  const briefing = kernelBriefing(dir)

  return [
    "You're taking over this session from another model: its conversation isn't here, but its work is (this session's kernel).",
    ...(briefing ? [briefing] : []),
    ...(exchanges.length ? [`The last exchanges:\n\n${exchanges.join("\n\n")}`] : []),
  ].join("\n\n")
}

// A new System Two takes over: its thread starts empty (the old one was the old backend's own), and it's told the
// takeover note on its first run. saved.thread goes back to 0, as after a compaction, so the new items reach the file.
export const switchConversation = (conversation: Conversation, dir: string) => {
  conversation.thread.length = 0
  conversation.size = undefined
  conversation.saved.thread = 0
  conversation.takeover = takeoverNote(dir, conversation)
  conversation.skillCatalogPending = true
  conversation.activeSkillsPending = true
}

// The session goes on with System Two `use` (a systemTwo.use name): recorded when it changes, and a change from one
// recorded before is a switch. Returns the backend it switched from, if it did. Recorded first: if that fails, nothing
// changes (a switch only in memory would bring the old thread back on resume).
export const useSystemTwo = (session: SessionHandle, conversation: Conversation, use: string) =>
  Effect.gen(function* () {
    const from = conversation.backend
    if (from === use) return undefined

    yield* session.record("systemTwo", use)
    if (from) switchConversation(conversation, session.dir)
    conversation.backend = use
    return from
  })

// A turn a restart cut short: its message (no answer and no stop after it), System Two's calls that finished since, the
// call a restart cut off, if one was running, with the effects it had started (src/tools/kernel-service.ts, EFFECTS), and
// effects started outside any call (System One's step, in kernel-one) that no finished step followed. `run`: the
// agent's run that sent the message, if it said (src/loop/turn.ts). `restarts`: how many restarts since the turn last made
// progress (a call that finished, not handed back as interrupted) or was parked; `parked`: it was, and hasn't restarted
// since (the agent's worker parks a turn that keeps crashing: empty-vessel-agent's core-worker.ts).
export type Effectful = { readonly id: string; readonly text: string; outcome?: string }
export type Unfinished = {
  readonly input: string
  readonly run?: string
  readonly calls: ReadonlyArray<LogEntry>
  readonly cut?: { readonly tool: string; readonly args: unknown; readonly effects: ReadonlyArray<Effectful> }
  readonly step: ReadonlyArray<Effectful>
  readonly restarts: number
  readonly parked: boolean
}

export const unfinishedTurn = (dir: string): Unfinished | undefined => {
  let open: { input: string; run?: string; calls: Array<LogEntry>; cut?: { tool: string; args: unknown; effects: Array<Effectful> }; step: Array<Effectful>; restarts: number; parked: boolean } | undefined
  const intents = new Map<string, Effectful>()

  for (const e of logEntries(readFileSync(`${dir}/main.jsonl`, "utf8"))) {
    if (e.role === "user") open = { input: e.text, ...(typeof e.run === "string" ? { run: e.run } : {}), calls: [], step: [], restarts: 0, parked: false }
    else if (!open) continue
    else if (e.role === "assistant") open = undefined
    else if (e.role === "step") open.step = [] // System One's step finished
    else if (e.role === "call" && e.started === true) open.cut = { tool: e.tool, args: e.args, effects: [] }
    else if (e.role === "call") {
      open.calls.push(e)
      delete open.cut
      if (e.interrupted !== true) open.restarts = 0
    }
    else if (e.role === "restart") {
      open.restarts++
      open.parked = false
    }
    else if (e.role === "parked") {
      open.restarts = 0
      open.parked = true
    }
    else if (e.role === "effect" && e.outcome !== undefined) { if (intents.has(e.id)) intents.get(e.id)!.outcome = String(e.outcome) }
    else if (e.role === "effect") {
      const intent = { id: String(e.id), text: e.text }
      intents.set(intent.id, intent)
      ;(open.cut?.effects ?? open.step).push(intent)
    }
  }

  return open
}

// What a run's finished turn answered, if one did: so a resume of a run whose answer was saved, but never reached the
// agent, doesn't do the turn again.
export const answerOf = (dir: string, run: string) => {
  let mine = false
  for (const e of logEntries(readFileSync(`${dir}/main.jsonl`, "utf8"))) {
    if (e.role === "user") mine = e.run === run
    else if (mine && e.role === "assistant") return e.text
  }
  return undefined
}

// A resume that has something to tell System Two: calls it made, a call cut off, or a step's effects. Otherwise the turn
// just runs again (nothing it did could have changed anything yet).
export const needsSystemTwo = (u: Unfinished) => u.calls.length > 0 || u.cut !== undefined || u.step.length > 0

// The calls a restart cut off that run again: a kernel cell that started no effect (none was recorded before it: KTD3's
// intent comes first), a question for the user (asking again is the point), a note, more output. Any other (a check
// System One runs, waiting for the user) is handed back.
const RERUN = new Set(["kernel", "ask_user", "tell_user", "more_output"])
const EACH_CALL = 2000 // characters of each call's arguments and of its output, in the note

const effectsLine = (effects: ReadonlyArray<Effectful>) =>
  effects.map((e) => `${e.text}${e.outcome === undefined ? " (may have run)" : ` (ran: ${e.outcome})`}`).join("; ")

// The cut-off call is settled first, as a call of this run: run again (recorded as any call), or handed back as
// interrupted (recorded with `interrupted: true`, so it isn't counted as progress). Then what System Two is told: its calls
// this turn, as saved, the latest first if they don't all fit in `budget` characters, and how the cut-off one ended.
// ponytail: a turn whose earlier System Two run finished has those calls in a Codex thread already; they're listed again.
export const resumeWork = (u: Unfinished, hooks: Hooks, state: CallState, budget: number) =>
  Effect.gen(function* () {
    const ended: Array<string> = []

    if (u.cut) {
      const { tool, args, effects } = u.cut
      const shown = shownAs(tool, args)

      if (!effects.length && RERUN.has(tool)) {
        const result = yield* callTool(tool, args, hooks, state)
        ended.push(`The last call, ${shown}, was cut off by the restart. It had started nothing with effects, so it was run again:\n${"output" in result ? result.output : result.answer}`)
      } else {
        const output = `interrupted: empty-vessel restarted while this ran, so it didn't finish and wasn't run again. It had started: ${effectsLine(effects) || "(nothing recorded)"}. Check what it did before redoing any of it.`
        yield* saveCall(tool, args, { output, interrupted: true }, true)
        ended.push(`The last call, ${shown}, was ${output}`)
      }
    }

    if (u.step.length) ended.push(`System One's last step was cut off by the restart after it started: ${effectsLine(u.step)}. It wasn't run again.`)

    const lines = u.calls.map((c) => `${shownAs(c.tool, c.args)} ${(JSON.stringify(c.args) ?? "").slice(0, EACH_CALL)}\n→ ${String(c.output ?? c.answer ?? "").slice(-EACH_CALL)}`)
    const { kept, left } = takeWithinBudget(lines, budget, "\n\n")

    return [
      "(empty-vessel restarted while you worked on this message. What your tool calls did before that, as saved:)",
      ...(left ? [`(${left} earlier call${left === 1 ? "" : "s"} not shown)`] : []),
      ...(kept.length ? kept : ["(no call had finished)"]),
      ...ended,
    ].join("\n\n")
  })

// A System Two that keeps its own conversation (Claude: the thread holds its session ids) starts a new one on resume,
// since the old one may end mid-call. Its first prompt carries our record instead: the kernel's cells and the exchanges
// so far, the latest first if they don't all fit in `budget` characters (src/plugins/claude/claude.ts, claudeFresh).
export const freshSession = (conversation: Conversation, dir: string, budget: number) => {
  if (!conversation.thread.some((t) => (t as { claudeSession?: string }).claudeSession)) return

  const exchanges = conversation.history.map((h) => `User: ${h.user}\nAnswer: ${h.answer}`)
  const { kept, left } = takeWithinBudget(exchanges, budget, "\n\n")
  const briefing = kernelBriefing(dir)
  const note = [
    "empty-vessel restarted, so this is a new conversation: the earlier one isn't here, but its record is.",
    ...(briefing ? [briefing] : []),
    ...(kept.length ? [`The exchanges so far${left ? ` (the last ${kept.length})` : ""}:\n\n${kept.join("\n\n")}`] : []),
  ].join("\n\n")

  conversation.thread.push({ claudeFresh: true }, userItem(note))
}
