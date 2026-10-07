import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { loadUsage, metricsAt, usageByModel, type UsageSample } from "../scripts/session-notebook-metrics"

const dirs: string[] = []
const oldHome = process.env.CODEX_HOME
const id = "01900000-0000-7000-8000-000000000001"
const source = `/sessions/${id}/main.jsonl`
const meta = { type: "session_meta", payload: { id, originator: "empty-vessel" } }
const usage = (ts = 10, counts: Record<string, unknown> = { input_tokens: 100, output_tokens: 20, cached_input_tokens: 30, reasoning_output_tokens: 5 }) => ({
  timestamp: new Date(ts).toISOString(), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: counts, total_token_usage: { input_tokens: 99999, output_tokens: 99999 } } },
})
const fixture = (records: unknown[]) => {
  const home = mkdtempSync(join(tmpdir(), "notebook-metrics-")); dirs.push(home); process.env.CODEX_HOME = home
  const start = new Date(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toISOString()
  const path = join(home, "sessions", ...start.slice(0, 10).split("-"), `rollout-empty-vessel-${start.replaceAll(":", "-")}-${id}.jsonl`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, records.map(r => typeof r === "string" ? r : JSON.stringify(r)).join("\n"))
  return { home, path }
}
afterEach(() => {
  if (oldHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = oldHome
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const row = (ts?: number, role = "assistant", text = "") => ({ ts, role, text })

test("exact UUID-derived mirror preserves identical records and counts subsets only once", () => {
  const { path } = fixture([meta, { type: "turn_context", payload: { model: "test-model" } }, usage(), usage()])
  const result = loadUsage(source)
  expect(result.source).toBe(path)
  expect(result.samples).toHaveLength(2)
  expect(result.samples[0]).toEqual({ ts: 10, input: 100, output: 20, cached: 30, thinking: 5, model: "test-model", system: "systemTwo", agent: `sessions/${id}`, provider: "codex" })
  expect(metricsAt([row(10)], result.samples)[0]).toMatchObject({ input: 200, output: 40, cached: 60, thinking: 10, calls: 2 })
  expect(result.note).toContain("coverage is not established")
})

test("cumulative mapping is inclusive, sorted, non-mutating and independent of event order", () => {
  const samples = [{ ts: 20, input: 2, output: 3 }, { ts: 10, input: 5, output: 7 }]
  const result = metricsAt([row(9), row(10), row(20), row(15), row(100)], samples)
  expect(result.map(r => [r.calls, r.input, r.output])).toEqual([[0, undefined, undefined], [1, 5, 7], [2, 7, 10], [1, 5, 7], [2, 7, 10]])
  expect(samples[0]!.ts).toBe(20)
  expect(result[0]!.cached).toBeUndefined()
})

test("missing optional fields remain unknown, whereas explicit zero stays zero", () => {
  fixture([meta, usage(10, { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, reasoning_output_tokens: 0 }), usage(20, { input_tokens: 1, output_tokens: 1 })])
  const loaded = loadUsage(source)
  expect(loaded.note).toContain("2 incomplete")
  const result = metricsAt([row(10), row(20)], loaded.samples)
  expect(result[0]).toMatchObject({ input: 0, output: 0, cached: 0, thinking: 0, calls: 1 })
  expect(result[1]!.cached).toBeUndefined()
  expect(result[1]!.thinking).toBeUndefined()
  expect(result[1]!.input).toBe(1)
})

test("malformed JSON, invalid timestamps/counts and incomplete usage are reported", () => {
  fixture([meta, "{broken", null, usage(10, { input_tokens: -1, output_tokens: 2 }),
    usage(10, { input_tokens: "10", output_tokens: 2 }), usage(10, { input_tokens: 1.5, output_tokens: 2 }),
    { ...usage(), timestamp: "invalid" }, { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 20 } } } },
    usage(20, { input_tokens: 3, output_tokens: 2, cached_input_tokens: 4, reasoning_output_tokens: null }), usage(30)])
  const loaded = loadUsage(source)
  expect(loaded.samples).toHaveLength(2)
  expect(loaded.samples[0]!.cached).toBeUndefined()
  expect(loaded.samples[0]!.thinking).toBeUndefined()
  expect(loaded.note).toContain("8 malformed")
  expect(loaded.note).toContain("1 incomplete")
})

test("missing, conflicting, foreign and wrong-id metadata reject all usage", () => {
  for (const records of [[usage()], [{ ...meta, payload: { id, originator: "codex" } }, usage()],
    [{ ...meta, payload: { id: "other", originator: "empty-vessel" } }, usage()],
    [meta, usage(), { ...meta, payload: { id, originator: "foreign" } }]]) {
    fixture(records)
    expect(loadUsage(source).samples).toEqual([])
    expect(loadUsage(source).note).toContain("rejected")
    expect(loadUsage(source).source).toBeUndefined()
  }
})

test("missing exact mirror never falls back to nearby/unrelated logs", () => {
  const { path } = fixture([meta, usage()])
  writeFileSync(join(dirname(path), "rollout-unrelated.jsonl"), JSON.stringify(meta) + "\n" + JSON.stringify(usage()))
  rmSync(path)
  expect(loadUsage(source).note).toContain("missing")
  expect(loadUsage(source).samples).toEqual([])
  expect(loadUsage("/sessions/not-a-uuid/main.jsonl").samples).toEqual([])
  expect(loadUsage(source.replace("main.jsonl", "other.jsonl")).samples).toEqual([])
})

test("invalid samples are ignored and invalid event timestamps never consume usage", () => {
  const samples = [null, { ts: NaN, input: 1, output: 1 }, { ts: 1e30, input: 1, output: 1 },
    { ts: 1, input: Infinity, output: 1 }, { ts: 1, input: -1, output: 1 }, { ts: 1, input: 1 },
    { ts: 10, input: 1, output: 2, cached: -1 }, { ts: 20, input: 2, output: 3 }] as UsageSample[]
  const result = metricsAt([row(undefined), row(NaN), row(Infinity), row(1e30), row(10), row(undefined), row(20)], samples)
  expect(result.map(r => r.calls)).toEqual([0, 0, 0, 0, 1, 0, 2])
  expect(result[5]!.input).toBeUndefined()
  expect(result[6]!.input).toBe(3)
  expect(result[6]!.cached).toBeUndefined()
})

test("context uses size records only and resets on compact and backend changes, not usage", () => {
  const rows = [row(1, "systemTwo", "a"), row(2, "size", "100"), row(3), row(4, "systemTwo", "a"),
    row(5, "compact", "~50"), row(6), row(7, "size", "40"), row(8, "systemTwo", "b"),
    row(9, "size", "0"), row(10, "size", "garbage"), row(11, "size", ""), row(12, "size", "-1")]
  const result = metricsAt(rows, [{ ts: 1, input: 500, output: 20 }])
  expect(result.map(r => r.context)).toEqual([undefined, 100, 100, 100, undefined, undefined, 40, undefined, 0, 0, 0, 0])
  expect(result[3]!.contextTs).toBe(2)
  expect(result[4]!.contextTs).toBeUndefined()
  expect(result[7]!.contextTs).toBeUndefined()
  expect(result[11]!.calls).toBe(1)
  expect(result[11]!.input).toBe(500)
  expect(metricsAt([row(undefined, "size", "12")], [])[0]).toMatchObject({ context: 12, contextTs: undefined, calls: 0 })
})

test("empty mirrors, unknown records and unsafe totals do not invent measurements", () => {
  fixture([meta, { type: "future", payload: {} }])
  expect(loadUsage(source).note).toContain("No valid per-call")
  expect(metricsAt([row(100)], [])[0]!.input).toBeUndefined()
  const huge = { ts: 1, input: Number.MAX_SAFE_INTEGER, output: 0 }
  expect(metricsAt([row(1)], [huge, huge])[0]!.input).toBeUndefined()
})

test("model breakdown preserves repeated calls, sorts deterministically and never adds subsets twice", () => {
  const repeated = { ts: 20, model: "beta", input: 100, output: 20, cached: 30, thinking: 5 }
  const samples = [repeated, { ...repeated, ts: 10, model: "alpha", input: 200 }, repeated]
  const before = JSON.stringify(samples)
  expect(usageByModel(samples)).toEqual([
    { model: "alpha", calls: 1, input: 200, output: 20, cached: 30, thinking: 5 },
    { model: "beta", calls: 2, input: 200, output: 40, cached: 60, thinking: 10 },
  ])
  expect(usageByModel([...samples].reverse())).toEqual(usageByModel(samples))
  expect(JSON.stringify(samples)).toBe(before)
  expect(usageByModel([])).toEqual([])
})

test("missing and blank models group together without merging explicit label collisions", () => {
  const sample = { ts: 1, input: 1, output: 0, cached: 0, thinking: 0 }
  const unknown = "(model not recorded)"
  const samples = [undefined, "", " \t", unknown, `${unknown} (recorded model)`, "__proto__"].map(model => ({ ...sample, model }))
  const result = usageByModel(samples)
  expect(result[0]).toEqual({ model: unknown, calls: 3, input: 3, output: 0, cached: 0, thinking: 0 })
  expect(result).toHaveLength(4)
  expect(new Set(result.map(r => r.model)).size).toBe(4)
  expect(result.find(r => r.model === `${unknown} (recorded model) (recorded model)`)!.calls).toBe(1)
  expect(usageByModel([...samples].reverse())).toEqual(result)
  expect(usageByModel([{ ...sample, model: unknown }])[0]!.model).toBe(unknown)
})

test("optional subsets remain unknown per group and field, while zero stays zero", () => {
  const base = { ts: 1, input: 10, output: 5, cached: 0, thinking: 0 }
  const samples = [
    { ...base, model: "missing-cache", cached: undefined }, { ...base, model: "missing-cache" },
    { ...base, model: "missing-thinking", thinking: undefined }, { ...base, model: "missing-thinking" },
    { ...base, model: "zero" },
    { ...base, model: "invalid-subsets", cached: 11, thinking: -1 },
    { ...base, model: "invalid-subsets" },
  ]
  const result = usageByModel(samples)
  expect(result.find(r => r.model === "missing-cache")).toMatchObject({ calls: 2, input: 20, output: 10, cached: undefined, thinking: 0 })
  expect(result.find(r => r.model === "missing-thinking")).toMatchObject({ cached: 0, thinking: undefined })
  expect(result.find(r => r.model === "zero")).toMatchObject({ cached: 0, thinking: 0 })
  expect(result.find(r => r.model === "invalid-subsets")).toMatchObject({ calls: 2, input: 20, output: 10, cached: undefined, thinking: undefined })
  for (const group of result) {
    const { context, contextTs, ...expected } = metricsAt([row(1)], samples.filter(s => s.model === group.model))[0]!
    const { model, ...actual } = group
    expect(actual).toEqual(expected)
  }
})

test("model breakdown excludes invalid required fields using metricsAt validation", () => {
  const base = { ts: 1, input: 1, output: 1, model: "invalid" }
  const invalid = [null, { ...base, ts: NaN }, { ...base, ts: 1e30 },
    { ...base, input: -1 }, { ...base, input: 1.5 }, { ...base, input: Infinity },
    { ...base, input: Number.MAX_SAFE_INTEGER + 1 }, { ...base, output: "1" },
    { ...base, output: undefined }] as UsageSample[]
  expect(usageByModel(invalid)).toEqual([])
  expect(usageByModel([...invalid, { ...base, model: "valid" }])).toEqual([
    { model: "valid", calls: 1, input: 1, output: 1, cached: undefined, thinking: undefined },
  ])
})

test("unsafe model totals become unknown independently and sort after known inputs", () => {
  const max = Number.MAX_SAFE_INTEGER
  const samples = [
    { ts: 1, model: "overflow", input: max, output: max, cached: max, thinking: max },
    { ts: 2, model: "overflow", input: 1, output: 1, cached: 1, thinking: 1 },
    { ts: 3, model: "overflow", input: 0, output: 0, cached: 0, thinking: 0 },
    { ts: 1, model: "safe", input: max, output: max, cached: max, thinking: max },
    { ts: 1, model: "partial", input: max, output: 1, cached: 0, thinking: 0 },
    { ts: 2, model: "partial", input: 1, output: 1, cached: 0, thinking: 0 },
    { ts: 1, model: "zero", input: 0, output: 0, cached: 0, thinking: 0 },
  ]
  const result = usageByModel(samples)
  expect(result.map(r => r.model)).toEqual(["safe", "zero", "overflow", "partial"])
  expect(result[0]).toMatchObject({ input: max, output: max, cached: max, thinking: max })
  expect(result[2]).toEqual({ model: "overflow", calls: 3, input: undefined, output: undefined, cached: undefined, thinking: undefined })
  expect(result[3]).toEqual({ model: "partial", calls: 2, input: undefined, output: 2, cached: 0, thinking: 0 })
  expect(usageByModel([...samples].reverse())).toEqual(result)
})

const durable = (overrides: Record<string, unknown> = {}) => ({ role: "usage", text: "model request", ts: 10, usageVersion: 1, usageId: "request-1", system: "systemOne", model: "jev-model", agent: `sessions/${id}`, input: 100, output: 20, ...overrides })
const mainFixture = (records: unknown[], mirrors: unknown[] = [meta], child?: string) => {
  const { home, path } = fixture(mirrors)
  const main = join(home, "sessions", id, ...(child ? [child] : []), "main.jsonl")
  mkdirSync(dirname(main), { recursive: true })
  writeFileSync(main, records.map(r => typeof r === "string" ? r : JSON.stringify(r)).join("\n"))
  return { main, path }
}
const identified = (usageId: unknown, ts = 10) => {
  const event = usage(ts)
  return { ...event, payload: { ...event.payload, usage_id: usageId } }
}

test("main Jev and Codex combine; durable wins IDs but equal separate calls survive", () => {
  const { main } = mainFixture([
    durable(), durable({ system: "systemTwo", model: "codex-model", usageId: "codex-1", cached: 0, provider: "codex", granularity: "provider-result" }),
    durable({ usageId: "request-2" }), durable(),
  ], [meta, identified("codex-1"), identified("codex-1"), identified("mirror-only"), identified("mirror-only")])
  const loaded = loadUsage(main)
  expect(loaded.samples).toHaveLength(4)
  expect(loaded.systemOneAvailable).toBe(true)
  expect(loaded.systemTwoAvailable).toBe(true)
  expect(loaded.source).toBe(main)
  expect(loaded.samples.find(s => s.usageId === "codex-1")).toMatchObject({ model: "codex-model", cached: 0, granularity: "provider-result" })
  expect(metricsAt([row(10)], loaded.samples)[0]).toMatchObject({ calls: 4, input: 400, output: 80, cached: undefined })
  expect(usageByModel(loaded.samples).find(s => s.model === "jev-model")!.calls).toBe(2)
})

test("resumed legacy and ID mirrors preserve calls and disclose unsupported overlap", () => {
  const { main } = mainFixture([durable({ system: "systemTwo", usageId: "new" })], [meta, usage(1), usage(1), identified("new"), usage(10)])
  const loaded = loadUsage(main)
  expect(loaded.samples).toHaveLength(4)
  expect(loaded.note).toContain("Unsupported overlap")
  expect(loaded.note).toContain("may double-count")
  expect(loaded.note).toContain("Jev usage unavailable")
  expect(loaded.systemOneAvailable).toBe(false)
})

test("invalid primary permits valid same-ID mirror fallback", () => {
  const { main } = mainFixture(["{broken", durable({ input: -1 })], [meta, identified("request-1")])
  const loaded = loadUsage(main)
  expect(loaded.samples).toHaveLength(1)
  expect(loaded.samples[0]!.system).toBe("systemTwo")
  expect(loaded.note).toContain("fallback loaded despite invalid primary")
  expect(loaded.systemOneAvailable).toBe(false)
})

test("durable validation rejects missing, foreign and corrupt required or optional data", () => {
  const invalid = [
    { usageVersion: 2 }, { text: "other" }, { ts: -1 }, { ts: 1.5 }, { ts: "10" }, { ts: 1e30 },
    { usageId: "" }, { usageId: " padded" }, { usageId: 1 }, { usageId: "bad\nID" },
    { model: " " }, { model: null }, { system: "other" }, { agent: `sessions/${id}/child` },
    { input: undefined }, { output: null }, { input: 1.1 }, { input: Number.MAX_SAFE_INTEGER + 1 },
    { cached: 101 }, { thinking: -1 }, { cached: null }, { provider: "" }, { granularity: "other" },
  ]
  const { main } = mainFixture(invalid.map(v => durable(v)))
  const loaded = loadUsage(main)
  expect(loaded.samples).toEqual([])
  expect(loaded.note).toContain(`${invalid.length} invalid main`)
  expect(loaded.systemOneAvailable).toBe(false)
  expect(loaded.systemTwoAvailable).toBe(false)
})

test("missing or foreign mirror metadata never suppresses valid main usage", () => {
  for (const mirrors of [[usage()], [{ ...meta, payload: { id, originator: "foreign" } }, usage()]]) {
    const { main } = mainFixture([durable()], mirrors)
    const loaded = loadUsage(main)
    expect(loaded.samples).toHaveLength(1)
    expect(loaded.note).toContain("Mirror rejected")
    expect(loaded.systemOneAvailable).toBe(true)
  }
  const { main, path } = mainFixture([durable()])
  rmSync(path)
  expect(loadUsage(main).samples).toHaveLength(1)
  expect(loadUsage(main).note).toContain("Matching mirror missing")
})

test("child agent must exactly match source and root never merges children", () => {
  const child = "01900000-0000-7000-8000-000000000002"
  const agent = `sessions/${id}/${child}`
  const { main, path } = mainFixture([durable(), durable({ agent, usageId: "child-call" })], [meta], child)
  const childMirror = path.replace(id, child)
  writeFileSync(childMirror, [
    { type: "session_meta", payload: { id: child, originator: "empty-vessel", empty_vessel_parent_session_id: id } }, identified("child-mirror"),
  ].map(r => JSON.stringify(r)).join("\n"))
  const loaded = loadUsage(main)
  expect(loaded.samples).toHaveLength(2)
  expect(loaded.samples.every(s => s.agent === agent)).toBe(true)
  const rootMain = join(dirname(dirname(main)), "main.jsonl")
  writeFileSync(rootMain, JSON.stringify(durable()))
  expect(loadUsage(rootMain).samples).toHaveLength(1)
  writeFileSync(childMirror, JSON.stringify({ type: "session_meta", payload: { id: child, originator: "empty-vessel" } }))
  expect(loadUsage(main).samples).toHaveLength(1)
  expect(loadUsage(main).note).toContain("Mirror rejected")
})

test("unavailable Jev is distinct from a recorded zero-token Jev call", () => {
  const old = mainFixture([{ role: "assistant", text: "no measurements", ts: 10 }], [meta, usage()])
  expect(loadUsage(old.main).note).toContain("Jev usage unavailable")
  expect(loadUsage(old.main).systemOneAvailable).toBe(false)
  const zero = mainFixture([durable({ input: 0, output: 0, cached: 0, thinking: 0 })])
  const loaded = loadUsage(zero.main)
  expect(loaded.systemOneAvailable).toBe(true)
  expect(loaded.systemTwoAvailable).toBe(false)
  expect(loaded.note).not.toContain("Jev usage unavailable")
  expect(metricsAt([row(10)], loaded.samples)[0]).toMatchObject({ input: 0, output: 0, calls: 1 })
})

test("malformed mirror IDs reject calls while missing models and subsets stay unknown", () => {
  const { main } = mainFixture([], [meta, identified(""), identified(2), identified("bad\nID"), identified("valid")])
  const loaded = loadUsage(main)
  expect(loaded.samples).toHaveLength(1)
  expect(loaded.samples[0]!.model).toBeUndefined()
  expect(loaded.note).toContain("3 malformed")
})
