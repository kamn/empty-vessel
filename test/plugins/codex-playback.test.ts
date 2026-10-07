import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect } from "effect"
import { codexRolloutIdentity, codexSessionMirror, recordCodexUsage } from "../../src/plugins/codex/rollout"

const upstream = process.env.AGENTPLAYBACK_ROOT
const rootId = "0194bece-a000-7000-8000-000000000001"
const childId = "0194bece-a001-7000-8000-000000000002"
const rootKey = `sessions/${rootId}`
const childKey = `${rootKey}/${childId}`
const epoch = Date.parse("2026-05-28T12:00:00Z")
const usage = { input: 100, cached: 20, output: 30, thinking: 10 }
type Session = {
  id: string; parentId: string | null; sub: boolean; cwd: string
  title: string; summary: string; models: string[]
  turnsByDay: Map<string, unknown[]>; file: string
  tokByDay: Map<string, [number, { i: number; cw: number; cr: number; o: number }, string][]>
}
const totals = (session: Session) => [...session.tokByDay.values()].flat()
  .reduce((sum, [, t]) => ({ input: sum.input + t.i + t.cr, cached: sum.cached + t.cr,
    output: sum.output + t.o }), { input: 0, cached: 0, output: 0 })

// Opt-in: importing this test without the flag never loads upstream or touches home.
describe.skipIf(!upstream)("Codex exporter → real AgentPlayback", () => {
  let temp: string
  let provider: any
  let core: any
  let previousHome: string | undefined
  let previousCache: string | undefined
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  beforeAll(async () => {
    previousHome = process.env.CODEX_HOME
    previousCache = process.env.DAYFLOW_CACHE
    temp = await mkdtemp(join(tmpdir(), "empty-vessel-playback-"))
    process.env.CODEX_HOME = join(temp, "codex")
    process.env.DAYFLOW_CACHE = join(temp, "cache")

    // fastscan captures DAYFLOW_CACHE at module evaluation: set both vars first.
    provider = (await import(pathToFileURL(join(upstream!, "scripts/providers/codex.mjs")).href)).default
    core = await import(pathToFileURL(join(upstream!, "scripts/lib/scan-core.mjs")).href)
  })

  afterAll(async () => {
    setSystemTime()
    restore("CODEX_HOME", previousHome)
    restore("DAYFLOW_CACHE", previousCache)
    if (temp) await rm(temp, { recursive: true, force: true })
  })

  beforeEach(async () => {
    setSystemTime(epoch)
    await rm(join(temp, "codex"), { recursive: true, force: true })
    await rm(join(temp, "cache"), { recursive: true, force: true })
  })

  const mirror = (key: string, role: string, text: string) =>
    codexSessionMirror({ key, role, text, ts: Date.now(), extra: {} })
  const emit = (key = rootKey, model = "gpt-5", counts = usage) =>
    recordCodexUsage(key, model, counts)
  const rows = async (key: string) => (await readFile(codexRolloutIdentity(key).path, "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line))
  const scan = async () => {
    // These modules only read local logs/cache; no pricing loader, auth or network.
    const ctx = { ...core, ...core.makeDayWindow(new Date(epoch), 2), HOME: temp }
    const plan = await provider.plan(ctx)
    return { plan, sessions: provider.finish(plan, ctx, null) as Session[] }
  }
  const session = (sessions: Session[], id = rootId) => {
    const found = sessions.find((s) => s.id === id)
    expect(found).toBeDefined()
    return found!
  }

  test("discovers dated UUID rollout and retains user title, cwd, summary and models", async () => {
    await Effect.runPromise(mirror(rootKey, "user", "Explain the playback integration"))
    await Effect.runPromise(emit())
    setSystemTime(epoch + 2000)
    await Effect.runPromise(emit(rootKey, "gpt-5-mini"))
    await Effect.runPromise(mirror(rootKey, "assistant", "Playback integration explained."))
    const identity = codexRolloutIdentity(rootKey)
    const start = new Date(parseInt(rootId.replaceAll("-", "").slice(0, 12), 16)).toISOString()
    expect(identity.path).toBe(join(temp, "codex", "sessions", ...start.slice(0, 10).split("-"),
      `rollout-empty-vessel-${start.replaceAll(":", "-")}-${rootId}.jsonl`))
    const { plan, sessions } = await scan()
    expect(plan.files.map((f: { path: string }) => f.path)).toEqual([identity.path])
    const parsed = session(sessions)
    expect(parsed.file).toBe(identity.path)
    expect(parsed.title).toBe("Explain the playback integration")
    expect(parsed.cwd).toBe(process.cwd())
    expect(parsed.summary).toBe("Playback integration explained.")
    expect(parsed.models.sort()).toEqual(["gpt-5", "gpt-5-mini"])
    expect([...parsed.turnsByDay.values()].flat().length).toBeGreaterThan(0)
    expect(totals(parsed)).toEqual({ input: 200, cached: 40, output: 60 })
  })

  test("resume preserves repeated equal request usage at distinct milliseconds", async () => {
    await Effect.runPromise(mirror(rootKey, "user", "Initial request"))
    await Effect.runPromise(emit())
    expect(totals(session((await scan()).sessions))).toEqual({ input: 100, cached: 20, output: 30 })
    const prefix = await readFile(codexRolloutIdentity(rootKey).path, "utf8")
    setSystemTime(epoch + 2000)
    await Effect.runPromise(mirror(rootKey, "user", "Resume the same session"))
    await Effect.runPromise(emit())
    expect((await readFile(codexRolloutIdentity(rootKey).path, "utf8")).startsWith(prefix)).toBe(true)
    expect((await rows(rootKey)).filter((r) => r.type === "session_meta")).toHaveLength(1)
    expect(totals(session((await scan()).sessions))).toEqual({ input: 200, cached: 40, output: 60 })
  })

  test("same-millisecond equal requests must not be globally deduplicated", async () => {
    await Effect.runPromise(mirror(rootKey, "user", "Two independent requests"))
    await Effect.runPromise(Effect.all([emit(), emit()], { concurrency: "unbounded" }))
    const events = (await rows(rootKey)).filter((r) => r.payload.type === "token_count")
    expect(events).toHaveLength(2)
    expect(events[0].timestamp).not.toBe(events[1].timestamp)
    expect(totals(session((await scan()).sessions))).toEqual({ input: 200, cached: 40, output: 60 })
  })

  test("child own usage matching parent prefix must survive fork trimming", async () => {
    await Effect.runPromise(mirror(rootKey, "user", "Root request"))
    await Effect.runPromise(emit())
    setSystemTime(epoch + 2000)
    await Effect.runPromise(mirror(childKey, "user", "Independent child request"))
    await Effect.runPromise(emit(childKey))
    const meta = (await rows(childKey))[0]
    expect(meta.payload.source).toBe("cli")
    expect(meta.payload.empty_vessel_parent_session_id).toBe(rootId)
    const { sessions } = await scan()
    expect(totals(session(sessions))).toEqual({ input: 100, cached: 20, output: 30 })
    const child = session(sessions, childId)
    expect(child.parentId).toBeNull()
    expect(child.sub).toBe(false)
    expect(totals(child)).toEqual({ input: 100, cached: 20, output: 30 })
  })

  test("concurrent root/child own calls under one second must survive burst trimming", async () => {
    await Effect.runPromise(Effect.all([
      mirror(rootKey, "user", "Concurrent root"), mirror(childKey, "user", "Concurrent child"),
    ], { concurrency: "unbounded" }))
    const childUsage = { input: 70, cached: 10, output: 15, thinking: 5 }

    for (const offset of [100, 600]) {
      setSystemTime(epoch + offset)
      await Effect.runPromise(Effect.all([
        emit(), emit(childKey, "gpt-5-mini", childUsage),
      ], { concurrency: "unbounded" }))
    }

    expect((await rows(childKey)).filter((r) => r.payload.type === "token_count")).toHaveLength(2)
    const { sessions } = await scan()
    expect(totals(session(sessions))).toEqual({ input: 200, cached: 40, output: 60 })
    const child = session(sessions, childId)
    expect(child.models).toEqual(["gpt-5-mini"])
    expect(totals(child)).toEqual({ input: 140, cached: 20, output: 30 })
  })
})
