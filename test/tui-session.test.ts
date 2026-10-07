import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { init, Message, type Model, update } from "../src/ui/tui/app"
import { loadView, saveView } from "../src/ui/tui/session"

const folders: string[] = []
const directory = () => {
  const dir = mkdtempSync(join(tmpdir(), "tui-session-"))
  folders.push(dir)
  return dir
}
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const log = (dir: string, entries: unknown[]) => writeFileSync(join(dir, "main.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
const populated = (): Model => ({
  ...init("current status", "banner"), input: "draft [Image #1]\n[Text #1]", after: 4,
  attached: [{ label: "[Image #1]", path: "/tmp/a b.png" }],
  pastes: [{ label: "[Text #1]", text: "long paste\n".repeat(20) }],
  history: ["first", "second\nline"], historyAt: 1, scrollBack: 29, total: "3m · 400 tokens",
  printed: [
    { kind: "banner", text: "banner" }, { kind: "user", text: "first" },
    { kind: "system-two", text: "  system two ran: kernel: read", body: "export default 1\n── result ──\n$1 (number) = 1", summary: "Read a value", open: true, sourceOpen: false, resultOpen: true },
    { kind: "system-two", text: "thought: planning", body: "one\ntwo\nthree\nfour\nfive", open: true, summary: "plan" },
    { kind: "note", text: "Public note", open: false },
    { kind: "reply", text: "Answer" }, { kind: "usage", text: "400 tokens", body: "", summary: "" },
  ],
})

test("roundtrip preserves bodies, independent expansions, draft cursor, pastes, history and scroll", () => {
  const dir = directory()
  const view = populated()
  saveView(dir, view)
  expect(loadView(dir, init("current status", "new banner"))).toEqual(view)
  expect(JSON.parse(readFileSync(join(dir, "tui-view.json"), "utf8")).version).toBe(1)
  expect(loadView(dir, init("new status")).status).toBe("new status")
  expect(view).toEqual(populated())
})

test("snapshot is authoritative, not appended to replay or the launch banner", () => {
  const dir = directory()
  log(dir, [{ role: "user", text: "first" }, { role: "assistant", text: "Answer" }])
  saveView(dir, populated())
  expect(loadView(dir, init("current status", "banner")).printed).toEqual(populated().printed)
})

test("interrupted queue and steering become inert visible text, never auto commands", () => {
  const dir = directory()
  const view: Model = { ...populated(), running: true, stopping: true, exiting: true, activity: "executing", frame: 27,
    queued: ["!dangerous command", "second queued"], steering: ["first", "unread message"] }
  saveView(dir, view)
  const loaded = loadView(dir, init("current status"))
  expect(loaded).toMatchObject({ running: false, stopping: false, exiting: false, activity: "", frame: 0, queued: [], steering: [], asking: null })
  expect(loaded.input).toBe(view.input)
  expect(loaded.after).toBe(view.after)
  expect(loaded.printed.filter((line) => line.text === "first")).toHaveLength(1)
  const text = loaded.printed.map((line) => line.text).join("\n")
  for (const pending of [...view.queued, ...view.steering]) expect(text).toContain(pending)
  expect(update(loaded, Message.Ticked()).commands).toBeUndefined()
  expect(update(loaded, Message.CompletedTurn({ reply: "done", usage: [] })).commands).toBeUndefined()
  saveView(dir, loaded)
  expect(loadView(dir, init("current status"))).toEqual(loaded)
})

test("question is not reactivated; both saved draft and unsent answer remain available", () => {
  const dir = directory()
  saveView(dir, { ...populated(), running: true, asking: { question: "Deploy?", options: ["yes", "no"] },
    selectedOption: 1, questionDraft: "original draft", input: "answer note [Text #1]", after: 2 })
  const loaded = loadView(dir, init("current status"))
  expect(loaded).toMatchObject({ input: "original draft", after: 0, asking: null, questionDraft: "", selectedOption: 0, running: false })
  const text = loaded.printed.map((line) => line.text).join("\n")
  expect(text).toContain("Deploy?")
  expect(text).toContain("Selected (not sent): no")
  expect(text).toContain("answer note [Text #1]")
  expect(loaded.pastes).toEqual(populated().pastes)
  expect(update(loaded, Message.Ticked()).commands).toBeUndefined()
})

test("missing and unreadable files fall back without throwing", () => {
  const dir = directory()
  const initial = init("status", "banner")
  expect(loadView(join(dir, "missing"), initial)).toEqual(initial)
  mkdirSync(join(dir, "tui-view.json"))
  mkdirSync(join(dir, "main.jsonl"))
  expect(loadView(dir, initial)).toEqual(initial)
})

test("corrupt, unsupported and structurally invalid snapshots replay the public log", () => {
  const dir = directory()
  log(dir, [{ role: "user", text: "recovered" }])
  const bad = ["{", "null", JSON.stringify({ version: 99, model: populated() }),
    ...[{ input: 123 }, { printed: [{ kind: "reply", text: "bad", resultOpen: "yes" }] },
      { after: -1 }, { after: 100000 }, { historyAt: 99 }, { scrollBack: 1.5 },
      { pastes: [{ label: "paste", text: false }] }, { asking: { question: "bad", options: [1] } },
    ].map((patch) => JSON.stringify({ version: 1, model: { ...populated(), ...patch } }))]

  for (const contents of bad) {
    writeFileSync(join(dir, "tui-view.json"), contents)
    expect(loadView(dir, init("status")).printed).toEqual([{ kind: "user", text: "recovered" }])
  }
})

test("legacy replay uses public cells and notes, enriches index titles and ignores private records", () => {
  const dir = directory()
  mkdirSync(join(dir, "kernel"))
  writeFileSync(join(dir, "kernel", "index.json"), JSON.stringify([
    { n: 1, title: "Read a value", summary: "$1 (number) = 1", status: "ok", defines: [] },
    { n: 2, title: "Unrecorded private cell", summary: "private", status: "ok", defines: [] },
  ]))
  log(dir, [
    { role: "project", text: "/private" }, { role: "user", text: "hello" },
    { role: "thread", text: "", item: { role: "assistant", content: "hidden thread" } },
    { role: "stash", text: "private stash", output: "secret" }, { role: "step", text: "debug private" },
    { role: "command", text: "kernel", args: { code: "export default 1" }, output: "cell 1: ok\n$1 (number) = 1" },
    { role: "command", text: "kernel", args: JSON.stringify({ name: "memo", text: "line one\nline two", summary: "Write memo" }), output: "cell 3: ok" },
    { role: "command", text: "tell_user", args: { message: "public note" }, output: "The user has it" },
    { role: "command", text: "tell_user", args: { message: "private transport caption", file: "/tmp/file" } },
    { role: "assistant", text: "answer" }, { role: "assistant", text: "answer" },
    { role: "command", text: "kernel", args: null },
  ])
  // A malformed entry must not discard later complete records or a valid last line without newline.
  writeFileSync(join(dir, "main.jsonl"), readFileSync(join(dir, "main.jsonl"), "utf8") + '{broken}\n{"role":"user","text":"last"}\n{"role":')
  const loaded = loadView(dir, init("status", "banner"))
  expect(loaded.printed.map((line) => line.kind)).toEqual(["banner", "user", "system-two", "system-two", "note", "reply", "reply", "user"])
  expect(loaded.printed[2]).toMatchObject({ summary: "Read a value", body: "export default 1\n── result ──\ncell 1: ok\n$1 (number) = 1" })
  expect(loaded.printed[3]).toMatchObject({ text: "  system two ran: kernel: text memo (2 lines)", summary: "Write memo" })
  expect(loaded.history).toEqual(["hello", "last"])
  expect(loaded.historyAt).toBe(2)
  expect(JSON.stringify(loaded)).not.toContain("private")
  expect(JSON.stringify(loaded)).not.toContain("hidden thread")
})

test("corrupt kernel index does not lose legacy cells or valid final records", () => {
  const dir = directory()
  mkdirSync(join(dir, "kernel"))
  writeFileSync(join(dir, "kernel", "index.json"), "{broken")
  writeFileSync(join(dir, "main.jsonl"), JSON.stringify({ role: "command", text: "kernel", args: { code: "export default 2" }, output: "cell 1: ok" }))
  expect(loadView(dir, init("status")).printed[0]?.body).toBe("export default 2\n── result ──\ncell 1: ok")
})

test("sessions are isolated and replacement leaves no temporary snapshot", () => {
  const root = directory()
  const a = join(root, "a"), b = join(root, "b")
  saveView(a, { ...init("a"), input: "first" })
  saveView(b, { ...init("b"), input: "second" })
  saveView(a, { ...init("a"), input: "replacement" })
  expect(loadView(a, init("a")).input).toBe("replacement")
  expect(loadView(b, init("b")).input).toBe("second")
  expect(readdirSync(a)).toEqual(["tui-view.json"])
})

test("save failures propagate, clean temporary files and preserve the previous snapshot", () => {
  const dir = directory()
  saveView(dir, populated())
  expect(() => saveView(dir, { ...populated(), after: -1 })).toThrow("Invalid TUI view")
  expect(loadView(dir, init("current status"))).toEqual(populated())
  expect(() => saveView(join(dir, "tui-view.json"), init("status"))).toThrow()
  const blocked = directory()
  mkdirSync(join(blocked, "tui-view.json"))
  expect(() => saveView(blocked, init("status"))).toThrow()
  expect(readdirSync(blocked)).toEqual(["tui-view.json"])
})

test("resume uses today's completion catalog, including snapshots made before autocomplete", () => {
  const dir = directory()
  const old = { ...init("old", undefined, [{ command: "/old", description: "removed skill" }]), input: "/", completionSelected: 9, completionDismissed: true }
  saveView(dir, old)
  const initial = init("new", undefined, [{ command: "/new", description: "current skill" }])
  const restored = loadView(dir, initial)
  expect(restored.input).toBe("/")
  expect(restored.completions).toEqual(initial.completions)
  expect(restored.completionSelected).toBe(0)
  expect(restored.completionDismissed).toBe(false)

  const snapshot = JSON.parse(readFileSync(join(dir, "tui-view.json"), "utf8"))
  delete snapshot.model.completions
  delete snapshot.model.completionSelected
  delete snapshot.model.completionDismissed
  writeFileSync(join(dir, "tui-view.json"), JSON.stringify(snapshot))
  expect(loadView(dir, initial)).toEqual(restored)
})
