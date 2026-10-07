import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { discoverSkills, renderSkills } from "../../src/base/skills"
import type { SessionHandle } from "../../src/base/session"
import { skillCommand } from "../../src/loop/skill-commands"
import { newConversation } from "../../src/loop/turnkit"
import { builtinCompletions, skillCompletions } from "../../src/skill-completions"
import { init, Message, update } from "../../src/ui/tui/app"
import { suggestions } from "../../src/ui/tui/completion"
import { live } from "../../src/ui/tui/view"

const folders: string[] = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "skill-completions-"))
  folders.push(root)
  const home = join(root, "home")
  const add = (name: string, description: string, fields = "", personal = false) => {
    const folder = join(personal ? home : join(root, ".empty-vessel"), "skills", name)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${fields}---\nDO NOT LOAD THIS BODY FOR A MENU\n`)
  }
  return { root, home, add }
}
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }) })

test("slash menu exposes skill management even without installed skills", () => {
  expect(skillCompletions({ skills: [], diagnostics: [] })).toEqual(builtinCompletions)
  const commands = builtinCompletions.map(item => item.command)
  expect(commands).toContain("/skills")
  expect(commands).toContain("/skills reload")
  expect(commands).toContain("/skills import")
  expect(commands).toContain("/skill")
  expect(commands).not.toContain("/help") // no such TUI command is implemented
})

test("menu uses resolved metadata, hides user-disabled and unsupported entries, and preserves manual skills", () => {
  const f = fixture()
  f.add("explain", "Personal description", "", true)
  f.add("explain", "Project description")
  f.add("manual", "Manual only", "disable-model-invocation: true\n")
  f.add("hidden", "Model only", "user-invocable: false\n")
  f.add("unsupported", "Not supported", "context: fork\n")
  f.add("review", "Custom review")
  const catalog = discoverSkills(f.root, f.home)
  const items = skillCompletions(catalog)
  expect(items.filter(item => item.command === "/explain")).toEqual([{ command: "/explain", description: "Project description", skillName: "explain" }])
  expect(items.some(item => item.command === "/manual")).toBe(true)
  expect(items.some(item => item.command === "/hidden" || item.command === "/unsupported")).toBe(false)
  expect(items.filter(item => item.command === "/review")).toHaveLength(1)
  expect(items.find(item => item.command === "/skill review")?.description).toBe("Custom review")
  let model = init("test", undefined, items)
  model = update(model, Message.UpdatedCompletions({ items: [...items] })).model
  model = update(model, Message.PressedKey({ key: "/skill e" })).model
  expect(suggestions(model).map(item => item.command)).toEqual(["/skill explain"])
  expect(update(model, Message.PressedKey({ key: "\t" })).model.input).toBe("/skill explain")
  expect(JSON.stringify(items)).not.toContain("DO NOT LOAD THIS BODY")
  expect(JSON.stringify(catalog)).not.toContain("DO NOT LOAD THIS BODY")
  expect(renderSkills(catalog)).not.toContain("scope-57")
})

test("reloading and importing immediately change the completion snapshot without activating a skill", async () => {
  const f = fixture(), conversation = newConversation()
  conversation.skills = discoverSkills(f.root, f.home)
  const session = { record: () => Effect.void } as unknown as SessionHandle
  f.add("newly-created", "New skill")
  expect(skillCompletions(conversation.skills).some(item => item.command === "/newly-created")).toBe(false)
  await Effect.runPromise(skillCommand(session, conversation, "/skills reload", f.root, f.home))
  expect(skillCompletions(conversation.skills).some(item => item.command === "/newly-created")).toBe(true)

  const source = join(f.root, "incoming")
  mkdirSync(source)
  writeFileSync(join(source, "SKILL.md"), "---\nname: imported\ndescription: Imported skill\n---\nInstructions")
  await Effect.runPromise(skillCommand(session, conversation, `/skills import ${source} --scope project`, f.root, f.home))
  expect(skillCompletions(conversation.skills).some(item => item.command === "/imported")).toBe(true)
  expect(conversation.activeSkills).toBeUndefined()
  rmSync(join(f.root, ".empty-vessel/skills/newly-created"), { recursive: true })
  await Effect.runPromise(skillCommand(session, conversation, "/skills reload", f.root, f.home))
  expect(skillCompletions(conversation.skills).some(item => item.command === "/newly-created")).toBe(false)
})

test("an exact /skill command wins over the longer /skills prefix on Enter", () => {
  const initial = init("test", undefined, builtinCompletions)
  const typed = update(initial, Message.PressedKey({ key: "/skill" })).model
  expect(suggestions(typed)[0]?.command).toBe("/skill")
  const submitted = update(typed, Message.PressedKey({ key: "\r" }))
  expect(submitted.model.running).toBe(true)
  expect(submitted.model.input).toBe("")
  expect(submitted.commands).toHaveLength(1)
})

test("suggestions fit remaining terminal height and keep the selected row visible", () => {
  let model = update(init("test", undefined, builtinCompletions), Message.PressedKey({ key: "/" })).model
  for (const height of [5, 6, 8, 24]) {
    const rendered = live(model, 79, height)
    expect(rendered.lines.length).toBeLessThanOrEqual(height)
    expect(rendered.cursor.row).toBeLessThan(height)
  }
  for (let i = 0; i < builtinCompletions.length - 1; i++) model = update(model, Message.PressedKey({ key: "\x1b[B" })).model
  const rendered = live({ ...model, total: "total" }, 79, 8)
  expect(rendered.lines.length).toBeLessThanOrEqual(8)
  expect(rendered.lines.join("\n")).toContain("/exit")
})
