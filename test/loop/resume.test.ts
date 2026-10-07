import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { stopped } from "../../src/answer"
import { makeSession } from "../../src/base/session"
import { diskStore } from "../../src/base/store"
import { Usage } from "../../src/base/usage"
import { cellsBeforeRules, kernelBriefing, loadConversation, olderCellsNote, saveConversation, switchConversation, takeoverNote, useSystemTwo } from "../../src/loop/resume"
import { newConversation } from "../../src/loop/turnkit"

const line = (o: object) => JSON.stringify(o)

test("loadConversation: history, actions, files, stash, size, and the thread from the last compaction on", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-session-"))
  writeFileSync(join(dir, "main.jsonl"), [
    line({ role: "project", text: "/x" }),
    line({ role: "user", text: "fix money" }), line({ role: "given", text: "src/money.ts" }),
    line({ role: "thread", item: { role: "user", n: 1 } }), line({ role: "thread", item: { type: "message", n: 2 } }),
    line({ role: "size", text: "5000" }), line({ role: "assistant", text: "fixed" }), line({ role: "actions", text: "gather · escalate" }),
    line({ role: "user", text: "and cart?" }),
    line({ role: "compact", text: "…", thread: [{ role: "user", n: "summary" }] }), line({ role: "stash", text: "out1", output: "full text" }),
    line({ role: "thread", item: { role: "user", n: 3 } }), line({ role: "size", text: "900" }), line({ role: "assistant", text: "fixed too" }),
    "",
  ].join("\n"))

  const c = loadConversation(dir)
  expect(c.history).toEqual([{ user: "fix money", answer: "fixed" }, { user: "and cart?", answer: "fixed too" }])
  expect(c.actions).toEqual(["gather · escalate"])
  expect([...c.files]).toEqual(["src/money.ts"])
  expect(c.stash.get("out1")).toBe("full text")
  expect(c.thread).toEqual([{ role: "user", n: "summary" }, { role: "user", n: 3 }]) // the compaction replaced what came before
  expect(c.size).toBe(900)
})

test("loadConversation: turns whose last step wasn't System Two are handed over after a resume; a System Two run clears them", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-session-"))
  writeFileSync(join(dir, "main.jsonl"), [
    line({ role: "user", text: "fix money" }), line({ role: "step", text: "escalate → ok: fixed" }), line({ role: "assistant", text: "fixed" }),
    line({ role: "user", text: "old tickets" }), line({ role: "step", text: "list_tickets → ok: PROJ-0" }), line({ role: "assistant", text: "PROJ-0" }),
    line({ role: "user", text: "triage" }), line({ role: "step", text: "escalate → ok: done" }), line({ role: "assistant", text: "done" }),
    // System Two ran first, then the ticket tool: the list is still news to it
    line({ role: "user", text: "list my open Jira tickets" }), line({ role: "step", text: "escalate → ok: I'll list them" }),
    line({ role: "step", text: "list_tickets → ok: PROJ-1 … PROJ-30" }), line({ role: "assistant", text: "PROJ-1 … PROJ-30" }),
    "",
  ].join("\n"))

  expect(loadConversation(dir).unseen).toEqual([{ user: "list my open Jira tickets", answer: "PROJ-1 … PROJ-30" }])
})

test("a stopped turn: its partial System Two run, hidden outputs and the stop note reach the session file; resume has them", async () => {
  const parent = mkdtempSync(join(tmpdir(), "empty-vessel-sessions-"))
  const session = await Effect.runPromise(makeSession("sessions").pipe(Effect.provide(diskStore(parent))))
  const conversation = newConversation()

  // A finished turn, saved as usual after System Two answered.
  conversation.thread.push({ role: "user", content: "Goal: first" }, { type: "message", content: "done" })
  await Effect.runPromise(saveConversation(session, conversation))

  // The next turn is stopped partway: System Two's items are in the live thread, never saved; one output was hidden.
  conversation.thread.push({ role: "user", content: "Goal: second" }, { type: "function_call", call_id: "c1" }, { type: "function_call_output", call_id: "c1" }, { type: "reasoning" })
  conversation.stash.set("out3", "the full output")
  await Effect.runPromise(stopped(session, "second", conversation).pipe(Effect.provide(Usage.layer)))

  const resumed = loadConversation(session.dir)
  expect(resumed.thread).toEqual(conversation.thread) // what the live session had, the dangling reasoning tidied away
  expect(resumed.thread.map((i) => (i as { type?: string; role?: string }).type ?? (i as { role: string }).role)).toEqual(["user", "message", "user", "function_call", "function_call_output", "user"])
  expect(resumed.stash.get("out3")).toBe("the full output")
  expect(resumed.actions).toEqual(["stopped by the user"])
})

test("resuming a session from before the kernel's rules: System Two is told once what its old cells defined and returned", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-resume-"))
  mkdirSync(join(dir, "kernel"))
  writeFileSync(join(dir, "main.jsonl"), "")
  writeFileSync(join(dir, "kernel", "index.json"), JSON.stringify([
    { n: 1, status: "ok", defines: ["tickets"], summary: "defined: tickets\n$1 (2 items) = [\"T-1\", \"T-2\"]" },
    { n: 2, status: "error", defines: [], summary: "boom" },
    { n: 4, status: "ok", defines: ["notes"], summary: "text cell: defined notes (3 lines, 40 characters)" }, // a string: still importable
    { n: 3, status: "ok", defines: ["shout"], rules: true, summary: "defined: shout" },
  ]))

  expect(cellsBeforeRules(dir)).toBe(1)
  const note = loadConversation(dir).olderCells!
  expect(note).toContain("1 cell from before the kernel's rules")
  expect(note).toContain("cell 1:\ndefined: tickets")
  expect(note).not.toContain("shout") // under the rules: importable as usual
  expect(note).not.toContain("notes")
  expect(olderCellsNote(mkdtempSync(join(tmpdir(), "empty-vessel-resume-")))).toBeUndefined()

  // A model taking over gets the importable ones: cells under the rules that ran
  const briefing = kernelBriefing(dir)!
  expect(briefing).toContain("2 cells that ran")
  expect(briefing).toContain("cell 3:\ndefined: shout")
  expect(briefing).toContain("cell 4:\ntext cell: defined notes")
  expect(briefing).not.toContain("tickets")
  expect(briefing).not.toContain("boom")
  expect(kernelBriefing(mkdtempSync(join(tmpdir(), "empty-vessel-resume-")))).toBeUndefined()
})

test("!command: its output joins the conversation (System One's history, System Two's next prompt, as yours) and survives a resume; !!command doesn't", async () => {
  const { userCommand } = await import("../../src/answer")
  const { handOver } = await import("../../src/loop/steps")
  const parent = mkdtempSync(join(tmpdir(), "empty-vessel-shell-"))
  const session = await Effect.runPromise(makeSession("sessions").pipe(Effect.provide(diskStore(parent))))
  const conversation = newConversation()

  expect(await Effect.runPromise(userCommand(session, conversation, "echo shared-output", true))).toContain("shared-output")
  expect(await Effect.runPromise(userCommand(session, conversation, "echo private-output", false))).toContain("private-output")
  expect(conversation.history.map((h) => h.user)).toEqual(["! echo shared-output"])  // !! isn't in it

  const resumed = loadConversation(session.dir)
  expect(resumed.unseen.map((h) => h.user)).toEqual(["! echo shared-output"])
  const told = await Effect.runPromise(handOver(resumed.unseen, (_l, o) => Effect.succeed(o), new Map()))
  expect(told).toContain("You ran `echo shared-output` in the terminal. Output:")
  expect(told).not.toContain("System One handled these")
  expect(told).not.toContain("private-output")
})

test("taking over: the note has the kernel's record and the recent exchanges, except turns the hand-over already carries", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-resume-"))
  mkdirSync(join(dir, "kernel"))
  writeFileSync(join(dir, "kernel", "index.json"), JSON.stringify([{ n: 1, status: "ok", defines: ["parseLog"], rules: true, summary: "defined: parseLog" }]))
  const c = newConversation()
  c.history.push({ user: "fix money", answer: "fixed" }, { user: "and cart?", answer: "fixed too" }, { user: "hi", answer: "hello" })
  c.unseen.push({ user: "hi", answer: "hello" })

  const note = takeoverNote(dir, c)
  expect(note).toContain("taking over")
  expect(note).toContain("cell 1:\ndefined: parseLog")
  expect(note).toContain("fix money")
  expect(note).toContain("fixed too")
  expect(note).not.toContain("hello")

  // Nothing yet: still a takeover, no empty sections
  const bare = takeoverNote(mkdtempSync(join(tmpdir(), "empty-vessel-resume-")), newConversation())
  expect(bare).toContain("taking over")
  expect(bare).not.toContain("cell")
})

test("switchConversation: the thread starts empty, the note waits for System Two, and new items are saved", async () => {
  const parent = mkdtempSync(join(tmpdir(), "empty-vessel-sessions-"))
  const session = await Effect.runPromise(makeSession("sessions").pipe(Effect.provide(diskStore(parent))))
  const c = newConversation()
  c.thread.push({ role: "user", content: "Goal: first" }, { type: "message", content: "done" })
  c.size = 5000
  await Effect.runPromise(saveConversation(session, c))

  switchConversation(c, session.dir)
  expect(c.thread).toEqual([])
  expect(c.size).toBeUndefined()
  expect(c.takeover).toContain("taking over")

  c.thread.push({ role: "user", content: "Goal: second" })
  await Effect.runPromise(saveConversation(session, c))
  expect(loadConversation(session.dir).thread.at(-1)).toEqual({ role: "user", content: "Goal: second" })
})

test("loadConversation: a change of System Two in the record drops the old backend's thread; the same one, or none recorded, keeps it", () => {
  const load = (lines: ReadonlyArray<object>) => {
    const dir = mkdtempSync(join(tmpdir(), "empty-vessel-session-"))
    writeFileSync(join(dir, "main.jsonl"), [...lines.map(line), ""].join("\n"))
    return loadConversation(dir)
  }
  const item = (n: number) => ({ role: "thread", item: { role: "user", n } })

  const switched = load([{ role: "systemTwo", text: "claude" }, item(1), { role: "systemTwo", text: "codex" }, item(2)])
  expect(switched.thread).toEqual([{ role: "user", n: 2 }])
  expect(switched.backend).toBe("codex")
  expect(load([{ role: "systemTwo", text: "claude" }, { role: "size", text: "9000" }, { role: "systemTwo", text: "codex" }]).size).toBeUndefined()

  expect(load([{ role: "systemTwo", text: "codex" }, item(1), { role: "systemTwo", text: "codex" }, item(2)]).thread).toHaveLength(2)

  const before = load([item(1), item(2)]) // a session from before backends were recorded
  expect(before.thread).toHaveLength(2)
  expect(before.backend).toBeUndefined()

  expect(load([item(1), { role: "systemTwo", text: "claude" }, item(2), { role: "systemTwo", text: "codex" }, item(3)]).thread).toEqual([{ role: "user", n: 3 }])
})

test("useSystemTwo: recorded on first use; a different one switches (and is what a resume finds); the same one changes nothing", async () => {
  const parent = mkdtempSync(join(tmpdir(), "empty-vessel-sessions-"))
  const session = await Effect.runPromise(makeSession("sessions").pipe(Effect.provide(diskStore(parent))))
  const c = newConversation()

  expect(await Effect.runPromise(useSystemTwo(session, c, "claude"))).toBeUndefined()
  c.thread.push({ role: "user", content: "Goal: first" })
  await Effect.runPromise(saveConversation(session, c))
  expect(await Effect.runPromise(useSystemTwo(session, c, "claude"))).toBeUndefined()
  expect(c.thread).toHaveLength(1)

  expect(await Effect.runPromise(useSystemTwo(session, c, "codex"))).toBe("claude")
  expect(c.thread).toEqual([])
  expect(c.takeover).toContain("taking over")
  const resumed = loadConversation(session.dir)
  expect(resumed.backend).toBe("codex")
  expect(resumed.thread).toEqual([])
})

test("loadConversation: a switch the new System Two hasn't run since still gets its takeover note; one it has run since doesn't", () => {
  const load = (lines: ReadonlyArray<object>) => {
    const dir = mkdtempSync(join(tmpdir(), "empty-vessel-session-"))
    writeFileSync(join(dir, "main.jsonl"), [...lines.map(line), ""].join("\n"))
    return loadConversation(dir)
  }
  const switched = [{ role: "systemTwo", text: "claude" }, { role: "thread", item: { role: "user", n: 1 } }, { role: "user", text: "fix money" }, { role: "step", text: "escalate → ok: fixed" }, { role: "assistant", text: "fixed" }, { role: "systemTwo", text: "codex" }]

  expect(load(switched).takeover).toContain("fix money")
  expect(load([...switched, { role: "thread", item: { role: "user", n: 2 } }]).takeover).toBeUndefined()
  expect(load([{ role: "systemTwo", text: "codex" }]).takeover).toBeUndefined()
})

test("useSystemTwo: if the switch can't be recorded, nothing changes (the old thread stays, for the backend still on file)", async () => {
  const c = newConversation()
  c.backend = "claude"
  c.thread.push({ role: "user", content: "Goal: first" })
  const broken = { dir: mkdtempSync(join(tmpdir(), "empty-vessel-resume-")), id: "s", record: () => Effect.fail(new Error("disk full")) } as unknown as Parameters<typeof useSystemTwo>[0]

  expect(await Effect.runPromise(Effect.exit(useSystemTwo(broken, c, "codex"))).then((e) => e._tag)).toBe("Failure")
  expect(c.backend).toBe("claude")
  expect(c.thread).toHaveLength(1)
  expect(c.takeover).toBeUndefined()
})

test("loadConversation: the agent the conversation works as comes back from its record", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-session-"))
  writeFileSync(join(dir, "main.jsonl"), [line({ role: "agent", text: "reviewer" }), line({ role: "user", text: "hi" }), ""].join("\n"))
  expect(loadConversation(dir).agent).toBe("reviewer")
})
