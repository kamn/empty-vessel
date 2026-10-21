import { expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { SessionHandle } from "../../src/base/session"
import { checkpointOf, redoCommand, snapshot, undoCommand } from "../../src/loop/checkpoint"
import { newConversation } from "../../src/loop/turnkit"
import { runBash } from "../../src/tools/bash"
import { Kernel } from "../../src/tools/kernel-service"

// A git repo with one committed file, a staged change and an untracked one, and the kernel working in it.
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-undo-"))
  execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: dir })
  writeFileSync(join(dir, "a.txt"), "one\n")
  execSync("git add a.txt && git -c user.email=t@t -c user.name=t commit -q -m a", { cwd: dir })
  writeFileSync(join(dir, "staged.txt"), "staged\n")
  execSync("git add staged.txt", { cwd: dir })
  writeFileSync(join(dir, "notes.txt"), "mine\n")
  const kernel = { ...Kernel.defaultValue(), exec: (command: string, ms: number) => runBash(`cd '${dir}'\n${command}`, ms) }
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect.pipe(Effect.provideService(Kernel, kernel)))
  // A turn: the files before, the change, the files after; its checkpoint, if it changed any.
  const turn = async (input: string, change: () => void) => {
    const before = await run(snapshot(dir))
    change()
    return checkpointOf(input, before, await run(snapshot(dir)))
  }
  return { dir, run, turn }
}
const session = { record: () => Effect.void } as unknown as SessionHandle
const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8")

test("/undo takes back what the last file-changing turn changed and removes what it created; the index is left alone", async () => {
  const { dir, run, turn } = repo()
  const conversation = newConversation()
  const index = execSync("git diff --cached --name-only", { cwd: dir }).toString()

  expect(await turn("just talk", () => {})).toBeUndefined() // a turn that changed nothing isn't a checkpoint
  conversation.checkpoints = [(await turn("fix a", () => {
    writeFileSync(join(dir, "a.txt"), "two\n")
    writeFileSync(join(dir, "new.txt"), "created\n")
    execSync("rm notes.txt", { cwd: dir })
  }))!]

  const reply = await run(undoCommand(session, conversation))

  expect(reply).toContain('Undid what "fix a" changed')
  expect(reply).toContain("- removed new.txt")
  expect(read(dir, "a.txt")).toBe("one\n")
  expect(read(dir, "notes.txt")).toBe("mine\n")
  expect(existsSync(join(dir, "new.txt"))).toBe(false)
  expect(execSync("git diff --cached --name-only", { cwd: dir }).toString()).toBe(index)
  expect(conversation.unseen.at(-1)?.user).toBe("/undo") // System Two hears of it
  expect(await run(undoCommand(session, conversation))).toStartWith("Nothing to undo")
})

test("/undo leaves what you changed after the turn: your new files, your edits, and the turn's files you edited again", async () => {
  const { dir, run, turn } = repo()
  const conversation = newConversation()
  conversation.checkpoints = [(await turn("edit a and b", () => {
    writeFileSync(join(dir, "a.txt"), "turn\n")
    writeFileSync(join(dir, "b.txt"), "turn\n")
  }))!]

  writeFileSync(join(dir, "mine.md"), "my notes\n") // after the turn, in the editor
  writeFileSync(join(dir, "notes.txt"), "edited by me\n")
  writeFileSync(join(dir, "b.txt"), "turn, then me\n")
  const reply = await run(undoCommand(session, conversation))

  expect(read(dir, "a.txt")).toBe("one\n")
  expect(read(dir, "mine.md")).toBe("my notes\n")
  expect(read(dir, "notes.txt")).toBe("edited by me\n")
  expect(read(dir, "b.txt")).toBe("turn, then me\n")
  expect(reply).toContain("- kept b.txt: it changed again after that turn")
})

test("/undo never removes a file the ignore rules before the turn covered (a .gitignore rewrite exposed it)", async () => {
  const { dir, run, turn } = repo()
  writeFileSync(join(dir, ".gitignore"), ".env\n")
  writeFileSync(join(dir, ".env"), "SECRET=1\n")
  const conversation = newConversation()
  conversation.checkpoints = [(await turn("tidy gitignore", () => { writeFileSync(join(dir, ".gitignore"), "node_modules\n") }))!]

  const reply = await run(undoCommand(session, conversation))

  expect(read(dir, ".env")).toBe("SECRET=1\n")
  expect(read(dir, ".gitignore")).toBe(".env\n")
  expect(reply).toContain("- kept .env: ignored before that turn")
})

test("a failed /undo keeps its checkpoint and says nothing was changed", async () => {
  const { run } = repo()
  const conversation = newConversation()
  conversation.checkpoints = [{ root: "/no/such/folder", before: "a".repeat(40), after: "b".repeat(40), input: "x" }]

  expect(await run(undoCommand(session, conversation))).toContain("nothing was changed")
  expect(conversation.checkpoints).toHaveLength(1)
})

test("the per-turn snapshot doesn't ask ActionGuard (an 'ask' policy would prompt every turn)", async () => {
  const { dir } = repo()
  const { ActionGuard } = await import("../../src/tools/action-guard")
  const asked: unknown[] = []
  const guard = { beforeAction: (action: unknown) => Effect.sync(() => { asked.push(action); return { decision: "deny" as const, reason: "no" } }) }
  expect(await Effect.runPromise(snapshot(dir).pipe(Effect.provideService(ActionGuard, guard as never)))).toBeDefined()
  expect(asked).toEqual([])
})

test("a kept index persists between snapshots and gives the same tree as a fresh one", async () => {
  const { dir } = repo()
  const index = join(mkdtempSync(join(tmpdir(), "empty-vessel-undo-index-")), "undo.index")

  const first = await Effect.runPromise(snapshot(dir, index))
  expect(existsSync(index)).toBe(true)
  const fresh = await Effect.runPromise(snapshot(dir))
  writeFileSync(join(dir, "later.txt"), "new\n")
  const kept = await Effect.runPromise(snapshot(dir, index))

  expect(first?.tree).toBe(fresh?.tree)
  expect(kept?.tree).not.toBe(first?.tree)
  expect(kept?.tree).toBe((await Effect.runPromise(snapshot(dir)))?.tree)
})

test("outside a git repo there's no snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-nogit-"))
  process.env.GIT_CEILING_DIRECTORIES = tmpdir() // so a parent folder's repo isn't found
  try { expect(await Effect.runPromise(snapshot(dir))).toBeUndefined() } finally { delete process.env.GIT_CEILING_DIRECTORIES }
})

test("a resumed session keeps /undo's checkpoints: recorded per turn, trimmed by each /undo; malformed ones are dropped", async () => {
  const { loadConversation } = await import("../../src/loop/resume")
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-undo-resume-"))
  const cp = (before: string, input: string) => ({ role: "checkpoint", text: before.repeat(40), after: "f".repeat(40), root: "/p", input })
  const lines = [
    { role: "project", text: "/p" },
    cp("a", "first"), cp("b", "second"),
    { role: "undone", text: "1" },
    { role: "checkpoint", text: "x; rm -rf /", after: "f".repeat(40), root: "/p", input: "forged" },
    cp("d", "fourth"),
  ]
  writeFileSync(join(dir, "main.jsonl"), lines.map((l) => JSON.stringify({ ...l, ts: 0 })).join("\n") + "\n")

  expect(loadConversation(dir).checkpoints?.map((c) => c.input)).toEqual(["first", "fourth"])
})

test("/undo records how many checkpoints are left", async () => {
  const { dir, run, turn } = repo()
  const conversation = newConversation()
  const recorded: Array<[string, string]> = []
  const recording = { record: (role: string, text: string) => Effect.sync(() => { recorded.push([role, text]) }) } as unknown as SessionHandle

  conversation.checkpoints = [(await turn("one", () => { writeFileSync(join(dir, "a.txt"), "changed\n") }))!]
  await run(undoCommand(recording, conversation))

  expect(recorded).toContainEqual(["undone", "0"])
})

test("/redo goes forward again after /undo, keeping what you changed in between; nothing to redo otherwise", async () => {
  const { dir, run, turn } = repo()
  const conversation = newConversation()
  expect(await run(redoCommand(session, conversation))).toStartWith("Nothing to redo")
  conversation.checkpoints = [(await turn("edit", () => {
    writeFileSync(join(dir, "a.txt"), "turn\n")
    writeFileSync(join(dir, "made.txt"), "by the turn\n")
    writeFileSync(join(dir, "notes.txt"), "turn too\n")
  }))!]

  await run(undoCommand(session, conversation))
  writeFileSync(join(dir, "notes.txt"), "mine after the undo\n")
  const reply = await run(redoCommand(session, conversation))

  expect(reply).toContain('Redid what "edit" changed')
  expect(read(dir, "a.txt")).toBe("turn\n")
  expect(read(dir, "made.txt")).toBe("by the turn\n")
  expect(read(dir, "notes.txt")).toBe("mine after the undo\n")
  expect(reply).toContain("- kept notes.txt: it changed again after the undo")
  expect(conversation.checkpoints).toHaveLength(1) // undoable again
  expect(await run(redoCommand(session, conversation))).toStartWith("Nothing to redo")
})

test("/undo of a turn that swapped a folder and a file puts both back without failing, and keeps going", async () => {
  const { dir, run, turn } = repo()
  const { mkdirSync, rmSync: rm } = await import("node:fs")
  mkdirSync(join(dir, "d"))
  writeFileSync(join(dir, "d", "x"), "in a folder\n")
  writeFileSync(join(dir, "f"), "a file\n")
  const conversation = newConversation()
  conversation.checkpoints = [(await turn("swap", () => {
    rm(join(dir, "d"), { recursive: true })
    writeFileSync(join(dir, "d"), "now a file\n")
    rm(join(dir, "f"))
    mkdirSync(join(dir, "f"))
    writeFileSync(join(dir, "f", "y"), "now in a folder\n")
  }))!]

  const reply = await run(undoCommand(session, conversation))

  expect(reply).toContain('Undid what "swap" changed')
  expect(read(dir, "d/x")).toBe("in a folder\n")
  expect(read(dir, "f")).toBe("a file\n")
  expect(conversation.redo).toHaveLength(1) // it worked: redoable, not lost
})

test("snapshots and /undo never run what the repo's config names: no filters, no fsmonitor", async () => {
  const { dir, run, turn } = repo()
  const ran = join(mkdtempSync(join(tmpdir(), "empty-vessel-filter-")), "ran")
  execSync(`git config filter.x.clean "touch '${ran}'; cat" && git config filter.x.smudge "touch '${ran}'; cat" && git config core.fsmonitor "touch '${ran}'; false"`, { cwd: dir })
  writeFileSync(join(dir, ".gitattributes"), "* filter=x\n")
  const conversation = newConversation()

  conversation.checkpoints = [(await turn("edit", () => { writeFileSync(join(dir, "a.txt"), "two\n") }))!]
  await run(undoCommand(session, conversation))

  expect(existsSync(ran)).toBe(false)
  expect(read(dir, "a.txt")).toBe("one\n")
})

test("snapshots work in a repo with a required filter (Git LFS), and a filter named with = can't run either", async () => {
  const { dir, run, turn } = repo()
  const ran = join(mkdtempSync(join(tmpdir(), "empty-vessel-filter-")), "ran")
  execSync(`git config filter.lfs.clean false && git config filter.lfs.required true && git config "filter.x=y.clean" "touch '${ran}'; cat"`, { cwd: dir })
  writeFileSync(join(dir, ".gitattributes"), "*.bin filter=lfs\n*.txt filter=x=y\n")
  writeFileSync(join(dir, "big.bin"), "data\n")
  const conversation = newConversation()

  const checkpoint = await turn("edit", () => { writeFileSync(join(dir, "a.txt"), "two\n") })
  expect(checkpoint).toBeDefined() // the required filter didn't stop the snapshot
  conversation.checkpoints = [checkpoint!]
  await run(undoCommand(session, conversation))

  expect(existsSync(ran)).toBe(false)
  expect(read(dir, "a.txt")).toBe("one\n")
})
