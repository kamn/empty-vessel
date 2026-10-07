import { readFileSync } from "node:fs"
import { Effect } from "effect"
import type { SessionHandle } from "../base/session"
import { fromSaved, toSaved } from "../base/images"
import { type Conversation, type Ctx, newConversation, unseenBySystemTwo } from "./turnkit"
import { type Cell, underRules } from "../kernel/kernel"

// Rebuild a conversation from its session file, to resume it: System One's history (user → assistant), its action lines,
// the files System Two was given, the stash, library tools handed to System One, System Two's thread (the last
// compaction's snapshot, then every item added after it), and the turns System Two hasn't heard about yet.
export const loadConversation = (dir: string): Conversation => {
  const c = newConversation()
  let user = "", lastStep: string | undefined, switched = false

  for (const line of readFileSync(`${dir}/main.jsonl`, "utf8").split("\n")) {
    if (!line) continue
    const e = JSON.parse(line)
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
      if (unseenBySystemTwo(lastStep)) c.unseen.push({ user, answer: e.text })
    }
    else if (e.role === "actions") c.actions.push(e.text)
    else if (e.role === "given") c.files.add(e.text)
    else if (e.role === "stash") c.stash.set(e.text, e.output)
    else if (e.role === "thread") c.thread.push(fromSaved(e.item))
    else if (e.role === "compact" && e.thread) c.thread.splice(0, c.thread.length, ...e.thread.map(fromSaved))
    else if (e.role === "size") c.size = Number(e.text)
    else if (e.role === "tools") c.tools.add(e.text)
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

// Cells' summaries as System Two saw them, under a heading: the latest first, if they don't all fit.
const EACH = 400, ALL = 4000 // characters of each cell's summary, and of the whole note
const cellsNote = (cells: ReadonlyArray<Cell>, heading: string) => {
  const lines = cells.map((c) => `cell ${c.n}:\n${c.summary.length > EACH ? `${c.summary.slice(0, EACH)}…` : c.summary}`)
  const kept: Array<string> = []
  for (const l of lines.reverse()) { if (kept.join("\n").length + l.length > ALL) break; kept.unshift(l) }
  const left = cells.length - kept.length

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
