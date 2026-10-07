import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { CurrentSession, makeSession, openSession } from "../src/base/session"
import { diskStore } from "../src/base/store"
import { recordUsage } from "../src/base/usage"
import { recordCodexUsage } from "../src/plugins/codex/rollout"
import { loadUsage, usageByModel } from "../scripts/session-notebook-metrics"
import { parseSession, renderSession } from "../scripts/session-notebook"

const homes: string[] = []
const originalCodexHome = process.env.CODEX_HOME
const setup = () => {
  const home = mkdtempSync(join(tmpdir(), "notebook-usage-pipeline-"))
  homes.push(home)
  process.env.CODEX_HOME = join(home, "codex")
  return home
}
afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

test("durable Jev and System Two usage flows through model table and timeline once across resume", () => {
  const home = setup()
  return Effect.runPromise(Effect.gen(function* () {
    const session = yield* makeSession("sessions")
    yield* session.record("user", "fixture request")
    const jevId = yield* recordUsage({ system: "systemOne", model: "jev-latest", tokens: { input: 200, output: 3 }, provider: "jev" }).pipe(Effect.provideService(CurrentSession, session))
    const codexId = yield* recordUsage({ system: "systemTwo", model: "test-astra", tokens: { input: 1000, output: 20, cached: 800, thinking: 4 }, provider: "codex" }).pipe(Effect.provideService(CurrentSession, session))
    expect(jevId).toBeString()
    expect(codexId).toBeString()
    yield* recordCodexUsage(session.key, "test-astra", { input: 1000, output: 20, cached: 800, thinking: 4 }, codexId)
    const reopened = yield* openSession(session.key)
    yield* recordUsage({ system: "systemOne", model: "jev-latest", tokens: { input: 200, output: 3 }, provider: "jev" }).pipe(Effect.provideService(CurrentSession, reopened))
    yield* reopened.record("assistant", "fixture complete")

    const source = join(session.dir, "main.jsonl")
    const rows = parseSession(readFileSync(source, "utf8"))
    const usage = loadUsage(source)
    expect(usage.samples).toHaveLength(3)
    expect(usage.samples.reduce((sum, sample) => sum + sample.input, 0)).toBe(1400)
    expect(usage.samples.reduce((sum, sample) => sum + sample.output, 0)).toBe(26)
    expect(usage.samples.every(sample => sample.agent === session.key)).toBe(true)
    expect(usageByModel(usage.samples).find(m => m.model === "jev-latest")).toMatchObject({ calls: 2, input: 400, output: 6 })
    const html = renderSession(source, rows, [], usage)
    expect(html).toContain("jev-latest")
    expect(html).toContain("test-astra")
    expect(html).toContain("System 1 / Jev usage recorded")
    expect(html).toContain("System 2 usage recorded")
    expect(html).toContain('<strong>1,400</strong><span>Recorded input · cumulative</span>')
    expect(html).toContain('<strong>26</strong><span>Recorded output · cumulative</span>')
    expect(html).toContain("System 1 / Jev so far: 400 in / 6 out")
    expect(html).toContain("System 2 so far: 1,000 in / 20 out")
  }).pipe(Effect.provide(diskStore(home))))
})

test("old sessions visibly disclose unavailable Jev usage instead of zero", () => {
  const home = setup()
  return Effect.runPromise(Effect.gen(function* () {
    const session = yield* makeSession("sessions")
    yield* session.record("user", "legacy request")
    yield* recordCodexUsage(session.key, "legacy-model", { input: 100, output: 5 })
    yield* session.record("assistant", "legacy answer")
    const source = join(session.dir, "main.jsonl")
    const usage = loadUsage(source)
    const html = renderSession(source, parseSession(readFileSync(source, "utf8")), [], usage)
    expect(usage.samples).toHaveLength(1)
    expect(html).toContain("Jev usage unavailable")
    expect(html).not.toContain("System 1 / Jev so far: 0 in / 0 out")
    expect(html).not.toContain("System 1 / Jev usage recorded")
    expect(html).toContain("legacy-model")
  }).pipe(Effect.provide(diskStore(home))))
})
