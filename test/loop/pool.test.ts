import { expect, test } from "bun:test"
import { Effect } from "effect"
import { appendFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadLibrary, loadPool, type PoolEntry, savePool } from "../../src/loop/library"
import { applicable, choose, record, settle, stats } from "../../src/loop/pool"

const tool = (name: string): PoolEntry => ({ name, description: `does ${name}`, file: "", from: "", for: "systemTwo" })
// A seeded random number generator, so the sampler's draws repeat.
const seeded = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }

test("the record is one line per event; stats count turns (several uses in one turn count once)", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-pool-"))
  const at = (turn: number) => ({ session: "s1", turn, tool: "grep", for: "systemTwo" as const })
  record(dir, { ...at(1), event: "offered" })
  record(dir, { ...at(1), event: "used", ok: true })
  record(dir, { ...at(1), event: "used", ok: false })
  record(dir, { ...at(2), event: "offered" })
  record(dir, { ...at(2), event: "verdict", helped: false })
  record(dir, { ...at(3), event: "offered" })
  record(dir, { ...at(3), event: "used", ok: false })
  record(dir, { ...at(3), event: "verdict", helped: true })

  record(dir, { ...at(4), event: "offered" })
  record(dir, { ...at(4), event: "verdict", applied: false, helped: false }) // not for this request: counts neither way
  expect(stats(dir).get("grep")).toEqual({ offered: 4, used: 2, ok: 1, helped: 1, applied: 2, notApplied: 1 }) // applied: turns 1 and 3

  record(dir, { ...at(0), event: "added" }) // proposed again: a fresh record
  record(dir, { ...at(5), event: "offered" })
  expect(stats(dir).get("grep")).toEqual({ offered: 1, used: 0, ok: 0, helped: 0, applied: 0, notApplied: 0 })
})

test("thompson favors the tool that keeps succeeding, but still tries one never offered", () => {
  const known = new Map([["good", { offered: 20, used: 18, ok: 18, helped: 0, applied: 20, notApplied: 0 }], ["bad", { offered: 20, used: 1, ok: 1, helped: 0, applied: 20, notApplied: 0 }]])
  const tools = [tool("good"), tool("bad"), tool("new")]
  const rng = seeded(7)
  const counts = { good: 0, bad: 0, new: 0 }
  for (let i = 0; i < 400; i++) counts[choose(tools, known, 1, "thompson", "ok", rng)[0]!.name as keyof typeof counts]++

  expect(counts.good).toBeGreaterThan(counts.new)
  expect(counts.new).toBeGreaterThan(counts.bad)
  expect(counts.new).toBeGreaterThan(20) // an untried tool gets its turn
  expect(choose(tools, known, 2, "all", "ok")).toHaveLength(3)
})

test("settling: enough successes graduate a tool (its kind kept), too many offers with too few successes drop it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-pool-"))
  savePool(dir, [{ ...tool("star"), for: "systemOne" }, tool("dud"), tool("young"), tool("fair")])
  // Each offer judged as applying (System Two ran and said so), as on turns where it was the right kind of request.
  const turns = (name: string, offered: number, ok: number) => {
    for (let t = 1; t <= offered; t++) {
      record(dir, { session: "s", turn: t, tool: name, for: "systemTwo", event: "offered" })
      if (name !== "offtopic") record(dir, { session: "s", turn: t, tool: name, for: "systemTwo", event: "verdict", applied: true, helped: false })
      if (t <= ok) record(dir, { session: "s", turn: t, tool: name, for: "systemTwo", event: "used", ok: true })
    }
  }
  turns("star", 4, 3) // 3 successes: graduates
  turns("dud", 10, 1) // 10 offers, 10%: dropped
  turns("young", 3, 0) // too few offers to judge
  turns("fair", 10, 2) // 20%: stays
  savePool(dir, [...loadPool(dir), tool("offtopic")])
  turns("offtopic", 12, 0) // offered 12 times, but never for its kind of request: stays
  for (let t = 1; t <= 12; t++) record(dir, { session: "s", turn: t, tool: "offtopic", for: "systemTwo", event: "verdict", applied: false, helped: false })

  const rules = { graduateAfter: 3, dropAfter: 10, dropBelowRate: 0.2, reward: "ok" as const }
  const { graduated, dropped } = await Effect.runPromise(settle(dir, rules, "s", 11))
  expect(graduated.map((e) => e.name)).toEqual(["star"])
  expect(dropped.map((e) => e.name)).toEqual(["dud"])
  expect(loadPool(dir).map((e) => e.name)).toEqual(["young", "fair", "offtopic"])
  expect(loadLibrary(dir)).toMatchObject([{ name: "star", for: "systemOne" }])
  expect(await Effect.runPromise(settle(dir, rules, "s", 12))).toEqual({ graduated: [], dropped: [] }) // settled: nothing moves twice
})

test("a broken line in the record (a crash mid-write) is skipped, not fatal", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-pool-"))
  record(dir, { session: "s", turn: 1, tool: "grep", for: "systemTwo", event: "offered" })
  appendFileSync(join(dir, "record.jsonl"), `{"session":"s","turn":2,"tool":"gr`) // cut off
  appendFileSync(join(dir, "record.jsonl"), "\n")
  record(dir, { session: "s", turn: 3, tool: "grep", for: "systemTwo", event: "offered" })
  expect(stats(dir).get("grep")?.offered).toBe(2)
})

test("only offers known to apply count: used, or a verdict said it applied; offers with no verdict count neither way", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-pool-"))
  const at = (turn: number) => ({ session: "s", turn, tool: "check", for: "systemOne" as const })
  for (let t = 1; t <= 50; t++) record(dir, { ...at(t), event: "offered" }) // turns System One answered alone: no verdict
  record(dir, { ...at(51), event: "offered" })
  record(dir, { ...at(51), event: "used", ok: true })
  record(dir, { ...at(52), event: "offered" })
  record(dir, { ...at(52), event: "verdict", applied: true, helped: false })
  const s = stats(dir).get("check")!
  expect(s.offered).toBe(52)
  expect(applicable(s)).toBe(2) // not 52: fifty offers nobody judged don't count against it
})
