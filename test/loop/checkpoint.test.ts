import { expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { SessionHandle } from "../../src/base/session"
import { snapshot, undoCommand } from "../../src/loop/checkpoint"
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
  return { dir, run }
}
const session = { record: () => Effect.void } as unknown as SessionHandle

test("/undo puts back what the last file-changing turn changed, removes what it created, and leaves the index alone", async () => {
  const { dir, run } = repo()
  const conversation = newConversation()
  const index = execSync("git diff --cached --name-only", { cwd: dir }).toString()

  conversation.checkpoints = [(await run(snapshot("fix a")))!]
  writeFileSync(join(dir, "a.txt"), "two\n")
  writeFileSync(join(dir, "new.txt"), "created\n")
  execSync("rm notes.txt", { cwd: dir })
  conversation.checkpoints.push((await run(snapshot("just talk")))!) // a turn that changed nothing

  const reply = await run(undoCommand(session, conversation))

  expect(reply).toContain('before "fix a"')
  expect(reply).toContain("removed new.txt")
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\n")
  expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("mine\n")
  expect(existsSync(join(dir, "new.txt"))).toBe(false)
  expect(execSync("git diff --cached --name-only", { cwd: dir }).toString()).toBe(index)
  expect(conversation.unseen.at(-1)?.user).toBe("/undo") // System Two hears of it
  expect(await run(undoCommand(session, conversation))).toStartWith("Nothing to undo")
})

test("outside a git repo there's no checkpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-nogit-"))
  const kernel = { ...Kernel.defaultValue(), exec: (command: string, ms: number) => runBash(`cd '${dir}'\nexport GIT_CEILING_DIRECTORIES='${tmpdir()}'\n${command}`, ms) }
  expect(await Effect.runPromise(snapshot("x").pipe(Effect.provideService(Kernel, kernel)))).toBeUndefined()
})
