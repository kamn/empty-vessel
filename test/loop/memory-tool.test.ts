import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { ALL } from "../../src/base/grants"
import { Memory, memoryOnStore } from "../../src/base/memory"
import { diskStore } from "../../src/base/store"
import { makeHost } from "../../src/loop/kernel"
import { builtinsModule } from "../../src/loop/library"
import { type Ctx, newConversation } from "../../src/loop/turnkit"
import { kernelInstructions } from "../../src/system-two/instructions"

// The memory built-in's host side, with a real memory (a small limit) and a session that only records.
const setUp = () => {
  const recorded: Array<[string, string]> = []
  const ctx = { conversation: newConversation(), session: { record: (role: string, text: string) => Effect.sync(() => { recorded.push([role, text]) }) } } as unknown as Ctx
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-")), root = mkdtempSync(join(tmpdir(), "empty-vessel-proj-"))
  const layer = memoryOnStore(root, { agent: 100, project: 60 }).pipe(Layer.provide(diskStore(home)))
  const call = (arg: unknown) => Effect.runPromise(Effect.gen(function* () {
    const host = makeHost(ctx, (yield* Effect.context<Memory>()) as never)
    return yield* host.memory!(arg)
  }).pipe(Effect.provide(layer)))
  const snapshot = () => Effect.runPromise(Effect.flatMap(Memory, (m) => m.snapshot).pipe(Effect.provide(layer)))
  return { ctx, recorded, call, snapshot }
}

test("the memory tool adds, replaces and removes; each change is recorded and kept for the end of the turn", async () => {
  const { ctx, recorded, call, snapshot } = setUp()
  expect(await call({ action: "add", scope: "project", text: "tests need APP_MODE=test" })).toBe("done: remembered (project): tests need APP_MODE=test")
  expect(await call({ action: "replace", scope: "project", old: "APP_MODE", text: "tests: APP_MODE=test bun test" })).toBe("done: updated (project): tests: APP_MODE=test bun test")
  expect(await snapshot()).toBe("About this project:\n- tests: APP_MODE=test bun test")
  expect(await call({ action: "remove", scope: "project", old: "bun test" })).toBe("done: forgot (project): bun test")

  expect(ctx.conversation.remembered).toEqual(["remembered (project): tests need APP_MODE=test", "updated (project): tests: APP_MODE=test bun test", "forgot (project): bun test"])
  expect(recorded.map(([role]) => role)).toEqual(["memory", "memory", "memory"])
})

test("the memory tool's refusals come back as text to act on: full, no or several matches, a bad scope, an empty entry", async () => {
  const { ctx, call } = setUp()
  await call({ action: "add", scope: "project", text: "one fact about the build" })
  expect(await call({ action: "add", scope: "project", text: "another fact, long enough to overflow" })).toStartWith("not done: project memory is full (")
  expect(await call({ action: "remove", scope: "project", old: "nothing like it" })).toBe('not done: no project entries contain "nothing like it"')
  await call({ action: "add", scope: "agent", text: "likes tea" })
  await call({ action: "add", scope: "agent", text: "likes short answers" })
  expect(await call({ action: "remove", scope: "agent", old: "likes" })).toBe('not done: several agent entries contain "likes"')
  expect(await call({ action: "add", scope: "team", text: "x" })).toBe('not done: no memory scope "team" (agent or project)')
  expect(await call({ action: "add", scope: "project", text: "  " })).toBe("not done: the entry is empty")
  expect(ctx.conversation.remembered).toEqual(["remembered (project): one fact about the build", "remembered (agent): likes tea", "remembered (agent): likes short answers"])
})

test("memory is part of the library grant: without it, it isn't a built-in and System Two isn't told of it", () => {
  expect(builtinsModule([], ALL)).toContain("memory")
  expect(builtinsModule([], { ...ALL, library: false })).not.toMatch(/\bmemory\b/)
  expect(kernelInstructions(ALL)).toContain("memory.add(")
  expect(kernelInstructions({ ...ALL, library: false })).not.toContain("memory.add(")
})
