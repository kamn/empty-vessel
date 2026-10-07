import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { Model } from "empty-vessel"
import { Events } from "../../src/base/events"
import { areaOf, scopeNote, watchScope } from "../../src/loop/scope"
import { callTool, newCallState } from "../../src/system-two/dispatch"
import { systemTwoFromModel } from "../../src/system-two/loop"
import { SystemTwo as Two, type Hooks } from "../../src/system-two/systemtwo"
import { Kernel, type KernelService } from "../../src/tools/kernel-service"

// Talking to the user mid-run (tell_user, the progress reminder), what the user says mid-run (steering), and the scope
// check: each reaches System Two with a tool result, in that order after the output.
const events: Array<{ kind: string; text: string }> = []
const seen = <A>(e: Effect.Effect<A>) => Effect.runPromise(e.pipe(Effect.provideService(Events, { emit: (ev) => Effect.sync(() => { events.push(ev) }) })))

test("tell_user shows the note as its own line and the run goes on; after the quiet time, a tool result asks for a note", async () => {
  let now = 0
  const state = newCallState(new Map(), () => now)
  const hooks: Hooks = { kernel: () => Effect.succeed("cell ok"), progressEveryMs: 5 * 60_000 }

  const told = await seen(callTool("tell_user", { message: "Tests pass; now the docs." }, hooks, state))
  expect(told).toEqual({ output: "The user has it. Keep working." })
  expect(events.filter((e) => e.kind === "note").map((e) => e.text)).toEqual(["Tests pass; now the docs."])
  expect(events.some((e) => e.text.includes("system two ran: tell_user"))).toBe(false)

  now = 4 * 60_000
  const early = await seen(callTool("kernel", { code: "x" }, hooks, state))
  expect("output" in early && early.output).toBe("cell ok")
  now = 6 * 60_000
  const reminded = await seen(callTool("kernel", { code: "x" }, hooks, state))
  expect("output" in reminded && reminded.output).toContain("send a short progress note with tell_user")
  const again = await seen(callTool("kernel", { code: "x" }, hooks, state)) // the clock restarted
  expect("output" in again && again.output).toBe("cell ok")
})

test("what the user typed mid-run comes with the next tool result, first, then the scope note, then the reminder", async () => {
  let inbox = ["use the v2 API"]
  const hooks: Hooks = {
    kernel: () => Effect.succeed("cell ok"), progressEveryMs: 1,
    inbox: Effect.sync(() => { const taken = inbox; inbox = []; return taken }),
    scope: () => Effect.succeed("[Scope: …]"),
  }
  const r = await seen(callTool("kernel", { code: "x" }, hooks, newCallState(new Map(), (() => { let t = 0; return () => (t += 10) })())))
  const parts = ("output" in r ? r.output : "").split("\n\n")
  expect(parts[0]).toBe("cell ok")
  expect(parts[1]).toBe("[The user, while you work: use the v2 API]")
  expect(parts[2]).toBe("[Scope: …]")
  expect(parts[3]).toContain("progress note")
})

test("the core loop: a message that arrives while System Two answers reaches its next request; it isn't done until it has read it", async () => {
  let inbox: Array<string> = []
  const asked: Array<ReadonlyArray<unknown>> = []
  const replies = ["Done: used v1.", "Switched to v2."]
  const model: Model = {
    name: "fake",
    complete: (r) => Effect.sync(() => {
      asked.push([...r.thread])
      if (asked.length === 1) inbox = ["use the v2 API"] // the user types while the first answer is being written
      return { text: replies[asked.length - 1]!, calls: [], keep: [], thinking: "", searches: [], usage: { input: 1, cached: 0, output: 1, thinking: 0 } }
    }),
  }
  const hooks: Hooks = { inbox: Effect.sync(() => { const taken = inbox; inbox = []; return taken }) }
  const answer = await seen(Two.use((s) => s.ask("fix it", hooks)).pipe(Effect.provide(systemTwoFromModel(model, 5))))
  expect(answer.text).toBe("Switched to v2.")
  expect(JSON.stringify(asked[1])).toContain("[The user, while you work: use the v2 API]")
})

test("scope areas: the nearest folder below the root with a package manifest, else the top-level folder", () => {
  const manifests = new Set(["packages/collab/package.json", "packages/sites/package.json", "package.json", "tools/go.mod"])
  expect(areaOf("packages/collab/src/index.ts", manifests)).toBe("packages/collab")
  expect(areaOf("packages/sites/wrangler.jsonc", manifests)).toBe("packages/sites")
  expect(areaOf("tools/cmd/main.go", manifests)).toBe("tools")
  expect(areaOf("docs/guide.md", manifests)).toBe("docs") // no manifest: its top-level folder
  expect(areaOf("README.md", manifests)).toBe(".")
})

test("scope: changes reaching another package than where the turn started get one ask-first note; the starting package doesn't", async () => {
  let status: Array<string> = [" M packages/collab/README.md"] // changed before the turn: not this turn's
  const kernel: KernelService = {
    open: () => { throw new Error("no cells") },
    exec: () => Effect.sync(() => `exit 0\n/repo\n${status.join("\0")}`),
    files: { list: () => Effect.succeed(["package.json", "packages/collab/package.json", "packages/sites/package.json"]), grep: () => Effect.succeed([]), read: () => Effect.succeed(undefined), size: () => Effect.succeed(0) },
  }
  const turn = {}
  const at = <A>(e: Effect.Effect<A>) => Effect.runPromise(e.pipe(Effect.provideService(Kernel, kernel)))
  await at(watchScope(turn, "fix the chunking"))

  status = [...status, " M packages/collab/src/index.ts", "?? packages/collab/src/chunk.ts"]
  expect(await at(scopeNote(turn))).toBeUndefined() // where it started
  status = [...status, " M packages/sites/src/build.ts"]
  const note = await at(scopeNote(turn))
  expect(note).toContain("started in packages/collab")
  expect(note).toContain("packages/sites (packages/sites/src/build.ts)")
  expect(note).toContain("ask them (ask_user)")
  status = [...status, " M packages/sites/src/other.ts"]
  expect(await at(scopeNote(turn))).toBeUndefined() // said once a turn
})

test("scope: where the work starts is the package the request names, even when the first change is elsewhere", async () => {
  let status: Array<string> = []
  const kernel: KernelService = {
    open: () => { throw new Error("no cells") },
    exec: () => Effect.sync(() => `exit 0\n/repo\n${status.join("\0")}`),
    files: { list: () => Effect.succeed(["packages/app/package.json", "packages/lib/package.json"]), grep: () => Effect.succeed([]), read: () => Effect.succeed(undefined), size: () => Effect.succeed(0) },
  }
  const turn = {}
  const at = <A>(e: Effect.Effect<A>) => Effect.runPromise(e.pipe(Effect.provideService(Kernel, kernel)))
  await at(watchScope(turn, "The test in packages/app fails: make it pass."))
  status = [" M packages/lib/math.ts"] // the first change, in another package
  expect(await at(scopeNote(turn))).toContain("started in packages/app, and these changes reach another part of the project: packages/lib")
})

test("commentary accompanying a tool call is emitted before the tool, not lost or repeated as the final answer", async () => {
  let round = 0
  const events: Array<{ kind: string; text: string }> = []
  const model: Model = {
    name: "progress-fixture",
    complete: () => Effect.sync(() => ({
      text: round++ === 0 ? "I will inspect the renderer." : "Finished.",
      calls: round === 1 ? [{ id: "k1", name: "kernel", arguments: JSON.stringify({ code: "export default 1" }) }] : [],
      keep: [], thinking: "", searches: [], usage: { input: 1, cached: 0, output: 1, thinking: 0 },
    })),
  }
  const result = await Effect.runPromise(Two.use((s) => s.ask("inspect", { kernel: () => Effect.succeed("cell 1: ok") })).pipe(
    Effect.provide(systemTwoFromModel(model, 5)),
    Effect.provideService(Events, { emit: (event) => Effect.sync(() => { events.push(event) }) }),
  ))
  const progress = events.filter((event) => event.kind !== "activity")
  expect(progress[0]).toMatchObject({ kind: "note", text: "I will inspect the renderer." })
  expect(progress[1]?.kind).toBe("system-two")
  expect(events.some((event) => event.text === "Finished.")).toBe(false)
  expect(result.text).toBe("Finished.")
})
