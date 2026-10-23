import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { projectDir } from "../../src/base/project"
import { diskStore, Store } from "../../src/base/store"
import { Reviewer } from "../../src/learning/reviewer"
import { makeHost } from "../../src/loop/kernel"
import { type PastArgs, type PastResult, pastSessions } from "../../src/loop/past"
import { indexSessions } from "../../src/loop/recall"
import type { Ctx } from "../../src/loop/turnkit"

// A temp home (with a fake-systems config.json, so nothing falls back to the real one) and two projects.
const setup = () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-"))
  writeFileSync(join(home, "config.json"), JSON.stringify({ ui: "plain", systemOne: { use: "fake" }, systemTwo: { use: "fake" } }))
  return { home, here: mkdtempSync(join(tmpdir(), "empty-vessel-proj-")), elsewhere: mkdtempSync(join(tmpdir(), "empty-vessel-other-")) }
}

type Line = readonly [string, string, number] | Record<string, unknown>
const lines = (from: number, entries: ReadonlyArray<Line>) =>
  entries.map((e, i) => JSON.stringify(Array.isArray(e) ? { role: e[0], text: e[1], seq: from + i, ts: e[2] } : { seq: from + i, ts: 0, ...e })).join("\n") + "\n"

const checks = new Map<string, string>()
const checksOf = (project: string) => checks.get(project) ?? checks.set(project, projectDir(project)).get(project)!

// A session file as the recorder writes it: its project line, then entries with seq.
const session = (home: string, id: string, project: string, entries: ReadonlyArray<Line>) => {
  mkdirSync(join(home, "sessions", id), { recursive: true })
  const head = { role: "project", text: project, checks: checksOf(project), seq: 0, ts: 0 }
  writeFileSync(join(home, "sessions", id, "main.jsonl"), JSON.stringify(head) + "\n" + lines(1, entries))
}

const fakeReviewer = (asked: Array<string>) => Reviewer.of({
  review: () => Effect.die("not used"),
  ask: (_instructions, _schema, input) => Effect.sync(() => {
    asked.push(input)
    return { value: { summary: "You chose an LRU cache over Redis." } as never, tokens: { input: 0, output: 0 } }
  }),
})

const run = (home: string, args: string | PastArgs, cwd: string, exclude?: string, asked: Array<string> = []) =>
  Effect.runPromise(pastSessions(args, { cwd, exclude }).pipe(Effect.provide(diskStore(home)), Effect.provideService(Reviewer, fakeReviewer(asked))))

test("discover: a word in two sessions returns both, ranked, with highlighted excerpts; the top hit is fuller", async () => {
  const { home, here } = setup()
  const long = `Redis ${"padding words go here ".repeat(40)} and the end`
  session(home, "01-old", here, [["user", "Should the cache use Redis?", 1000], ["assistant", "We decided: no Redis, an LRU cache. Redis Redis.", 2000], ["thread", "Redis internals", 2500]])
  session(home, "02-new", here, [["assistant", long, 4000]])
  session(home, "03-none", here, [["user", "unrelated", 5000]])

  const found = await run(home, "redis", here)

  expect(found.sessions.map((s) => s.session).sort()).toEqual(["01-old", "02-new"])
  expect(found.sessions[0]!.session).toBe("01-old") // denser match ranks first
  expect(found.sessions[0]!.messages[0]!.text).toContain("**Redis**")
  expect(found.sessions[0]!.messages.every((m) => typeof m.seq === "number" && m.role !== ("thread" as never))).toBe(true)
  expect(found.sessions[1]!.messages[0]!.text.length).toBeLessThan(long.length) // later hits are excerpts
  expect((await run(home, "  ", here)).sessions).toEqual([])
})

test("discover: another project's sessions only with allProjects; the current session and child sessions left out; system entries not searched", async () => {
  const { home, here, elsewhere } = setup()
  session(home, "01-here", here, [["user", "redis here", 1000], { role: "user", text: "redis from a job", origin: "cron" }])
  session(home, "02-there", elsewhere, [["user", "redis there", 2000]])
  session(home, "03-current", here, [["user", "redis now?", 3000]])
  mkdirSync(join(home, "sessions", "01-here", "child"), { recursive: true })
  writeFileSync(join(home, "sessions", "01-here", "child", "main.jsonl"), lines(0, [["user", "redis child", 1]]))

  const mine = await run(home, "redis", here, "03-current")
  expect(mine.sessions.map((s) => s.session)).toEqual(["01-here"])
  expect(mine.sessions[0]!.messages.map((m) => m.text)).toEqual(["**redis** here"])

  const all = await run(home, { query: "redis", allProjects: true }, here, "03-current")
  expect(all.sessions.map((s) => s.session).sort()).toEqual(["01-here", "02-there"])
})

test("scroll returns the messages around a hit; read the whole session (system entries labelled); unknown ids fail", async () => {
  const { home, here } = setup()
  session(home, "01", here, [["user", "one", 1], ["assistant", "two", 2], ["thread", "hidden", 3], ["user", "three needle", 4], ["assistant", "four", 5], ["user", "five", 6], { role: "user", text: "job says hi", origin: "cron" }])

  const hit = (await run(home, "needle", here)).sessions[0]!.messages[0]!
  const around = await run(home, { mode: "scroll", session: "01", seq: hit.seq, window: 1 }, here)
  expect(around.sessions[0]!.messages.map((m) => m.text)).toEqual(["two", "three needle", "four"])

  const all = await run(home, { mode: "read", session: "01" }, here)
  expect(all.sessions[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "system"])
  expect(all.sessions[0]!.messages.at(-1)!.text).toContain("cron")

  expect(run(home, { mode: "read", session: "../01" }, here)).rejects.toThrow(/no session/)
  expect(run(home, { mode: "scroll", session: "01" }, here)).rejects.toThrow(/seq/)
})

test("incremental: a new entry is searchable on the next call; a deleted session's rows are dropped", async () => {
  const { home, here } = setup()
  session(home, "01", here, [["user", "alpha", 1]])
  session(home, "02", here, [["user", "alpha too", 1]])
  expect((await run(home, "alpha", here)).sessions).toHaveLength(2)

  appendFileSync(join(home, "sessions", "01", "main.jsonl"), lines(2, [["assistant", "zebra crossing", 2]]) + '{"role":"assis') // a torn last line waits
  expect((await run(home, "zebra", here)).sessions.map((s) => s.session)).toEqual(["01"])

  rmSync(join(home, "sessions", "02"), { recursive: true })
  expect((await run(home, "alpha", here)).sessions.map((s) => s.session)).toEqual(["01"])
  const db = new Database(join(home, "recall.db"))
  expect(db.query("SELECT count(*) AS n FROM entries WHERE session = '02'").get()).toEqual({ n: 0 })
  expect(db.query("SELECT count(*) AS n FROM entries").get()).toEqual({ n: 2 })
  db.close()
})

test("a fork indexes only what came after its fork point", async () => {
  const { home, here } = setup()
  session(home, "01-parent", here, [["user", "parent words", 1]])
  session(home, "02-fork", here, [["user", "parent words", 1], { role: "forked", text: "01-parent" }, ["user", "fork words", 3]])

  expect((await run(home, "parent", here)).sessions.map((s) => s.session)).toEqual(["01-parent"])
  expect((await run(home, "fork", here)).sessions.map((s) => s.session)).toEqual(["02-fork"])
})

test("summarize: true runs the hits through the reviewer", async () => {
  const { home, here } = setup()
  session(home, "01", here, [["assistant", "We decided on an LRU cache, not Redis.", 1]])
  const asked: Array<string> = []

  const found = await run(home, { query: "redis", summarize: true }, here, undefined, asked)

  expect(found.summary).toBe("You chose an LRU cache over Redis.")
  expect(asked[0]).toContain("LRU cache")
  expect((await run(home, "redis", here)).summary).toBeUndefined()
})

test("two concurrent index passes make no duplicate rows and no busy error", async () => {
  const { home, here } = setup()
  for (let i = 0; i < 150; i++) session(home, `s${String(i).padStart(4, "0")}`, here, [["user", `word${i} shared`, i]])
  const script = `import { Effect } from "effect"; import { diskStore } from "${join(import.meta.dir, "../../src/base/store")}"; import { indexSessions } from "${join(import.meta.dir, "../../src/loop/recall")}"
await Effect.runPromise(indexSessions.pipe(Effect.provide(diskStore(${JSON.stringify(home)}))))`

  const passes = [0, 1, 2].map(() => Bun.spawn(["bun", "-e", script], { stderr: "pipe", cwd: join(import.meta.dir, "../..") }))
  const codes = await Promise.all(passes.map(async (p) => [await p.exited, await new Response(p.stderr).text()]))

  expect(codes).toEqual([[0, ""], [0, ""], [0, ""]])
  const db = new Database(join(home, "recall.db"))
  expect(db.query("SELECT count(*) AS n FROM entries").get()).toEqual({ n: 150 })
  expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
  db.close()
})

test("1,000 sessions: the second search reads no log it already indexed", async () => {
  const { home, here } = setup()
  for (let i = 0; i < 1000; i++) session(home, `s${String(i).padStart(4, "0")}`, here, [["user", `topic${i} about caching`, i], ["assistant", "an answer", i]])
  await Effect.runPromise(indexSessions.pipe(Effect.provide(diskStore(home))))

  // Same size, different words: a pass that re-read the file would find "zzzzz".
  const file = join(home, "sessions", "s0007", "main.jsonl")
  const text = await Bun.file(file).text()
  writeFileSync(file, text.replace("topic7 about", "zzzzz abouts"))

  const started = performance.now()
  const found = await run(home, "topic999", here)
  const took = performance.now() - started

  expect(found.sessions.map((s) => s.session)).toEqual(["s0999"])
  expect((await run(home, "zzzzz", here)).sessions).toEqual([])
  expect(took).toBeLessThan(1000)
})

test("the kernel's pastSessions: only known fields reach it, this conversation's session is left out, a bad mode fails", async () => {
  const { home } = setup()
  const cwd = process.cwd() // the host searches the project it runs in
  session(home, "01-earlier", cwd, [["user", "the flamingo plan", 1]])
  session(home, "02-current", cwd, [["user", "flamingo again?", 2]])
  const ctx = { session: { key: "sessions/02-current" } } as unknown as Ctx
  const call = (arg: unknown) => Effect.runPromise(Effect.gen(function* () {
    const host = makeHost(ctx, (yield* Effect.context<Store | Reviewer>()) as never)
    return yield* host.pastSessions!(arg) as Effect.Effect<PastResult, Error>
  }).pipe(Effect.provide(diskStore(home)), Effect.provideService(Reviewer, fakeReviewer([]))))

  expect((await call({ query: "flamingo" })).sessions.map((s) => s.session)).toEqual(["01-earlier"])
  expect((await call({ query: "flamingo", summarize: true, extra: "ignored" })).summary).toBe("You chose an LRU cache over Redis.")
  expect((await call({ mode: "read", session: "02-current" })).sessions[0]!.messages.map((m) => m.text)).toEqual(["flamingo again?"])
  expect(call({ query: "flamingo", mode: "everything" })).rejects.toThrow(/discover, scroll or read/)
  expect(call({ query: " " })).rejects.toThrow(/query of words/)
})
