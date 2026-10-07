import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type PoolEntry, updateTools } from "./library"

// The pool: candidate tools that have to prove themselves before they join the
// library. Each turn a few are offered (to System One as options, to System Two as names in its prompt), and what happens is
// recorded, one line per event, so the reward rule can change later without losing history.
// Two kinds: System One tools take the request and give the answer; System Two tools are helpers it calls as it likes.

// The pool's entries themselves live next to the library's (loadPool in src/loop/library.ts).

// One event: a tool was offered this turn, or used (with whether it ran without error), or given a verdict.
export type Event = { readonly session: string; readonly turn: number; readonly tool: string; readonly for: "systemOne" | "systemTwo" } &
  ({ readonly event: "offered" } | { readonly event: "used"; readonly ok: boolean } | { readonly event: "verdict"; readonly applied?: boolean; readonly helped: boolean; readonly why?: string } |
  { readonly event: "graduated" | "dropped"; readonly stats: Stats } | { readonly event: "added" })

export const record = (dir: string, e: Event) => {
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, "record.jsonl"), `${JSON.stringify({ ...e, at: Date.now() })}\n`)
}

// applied: turns the tool is known to have been for (it was used, or System Two's verdict said it applied). Only
// those count toward graduating and dropping: an offer nobody judged (a turn System One answered alone, a sub-agent's turn)
// says nothing about the tool, and counting it as a non-use dropped good tools. notApplied: said not to apply.
export type Stats = { readonly offered: number; readonly used: number; readonly ok: number; readonly helped: number; readonly applied: number; readonly notApplied: number }
export const applicable = (s: Stats) => s.applied

// Per tool, from the record: turns offered, and turns it was used, used without error, said to have helped, known to
// apply, and said not to. Only events since the tool was last added count (a tool proposed again starts afresh). A
// line that doesn't parse (a crash mid-write) is skipped: a broken record must never stop a turn.
export const stats = (dir: string): ReadonlyMap<string, Stats> => {
  let lines: Array<string> = []
  try { lines = readFileSync(join(dir, "record.jsonl"), "utf8").split("\n").filter(Boolean) } catch {}

  const fresh = () => ({ offered: new Set<string>(), used: new Set<string>(), ok: new Set<string>(), helped: new Set<string>(), applied: new Set<string>(), notApplied: new Set<string>() })
  const turns = new Map<string, ReturnType<typeof fresh>>()
  for (const line of lines) {
    let e: Event
    try { e = JSON.parse(line) } catch { continue }
    if (e.event === "added") { turns.set(e.tool, fresh()); continue }
    const t = turns.get(e.tool) ?? fresh()
    const key = `${e.session}/${e.turn}`
    if (e.event === "offered") t.offered.add(key)
    if (e.event === "used") { t.used.add(key); t.applied.add(key); if (e.ok) t.ok.add(key) }
    if (e.event === "verdict" && e.helped) t.helped.add(key)
    if (e.event === "verdict" && (e.applied || e.helped)) t.applied.add(key)
    if (e.event === "verdict" && e.applied === false && !e.helped) t.notApplied.add(key)
    turns.set(e.tool, t)
  }

  return new Map([...turns].map(([tool, t]) => [tool, { offered: t.offered.size, used: t.used.size, ok: t.ok.size, helped: t.helped.size, applied: t.applied.size, notApplied: t.notApplied.size }]))
}

// A draw from Beta(a, b) for whole a, b ≥ 1: Gamma(k) is a sum of k exponentials.
const gamma = (k: number, rng: () => number) => { let x = 0; for (let i = 0; i < k; i++) x -= Math.log(1 - rng()); return x }
const beta = (a: number, b: number, rng: () => number) => { const x = gamma(a, rng); return x / (x + gamma(b, rng)) }

// Which pool tools to offer this turn. "thompson": each tool's chance of success is drawn from what's known (few
// offers: a wide guess, so untried tools get their turn), and the best draws win. `rng` is passed in for tests.
export const choose = (entries: ReadonlyArray<PoolEntry>, known: ReadonlyMap<string, Stats>, n: number, how: "thompson" | "uniform" | "all", reward: "used" | "ok" | "verdict", rng: () => number = Math.random) => {
  if (how === "all") return entries
  const score = (e: PoolEntry) => {
    if (how === "uniform") return rng()
    const s = known.get(e.name) ?? { offered: 0, used: 0, ok: 0, helped: 0, applied: 0, notApplied: 0 }
    const wins = reward === "used" ? s.used : reward === "ok" ? s.ok : s.helped
    return beta(1 + wins, 1 + Math.max(0, applicable(s) - wins), rng)
  }
  return entries.map((e) => ({ e, score: score(e) })).sort((a, b) => b.score - a.score).slice(0, n).map((x) => x.e)
}

const successes = (s: Stats, reward: "used" | "ok" | "verdict") => (reward === "used" ? s.used : reward === "ok" ? s.ok : s.helped)

// Settle the pool before a turn samples it: a tool with `graduateAfter` successes joins the library (same kind); one
// offered `dropAfter` times where it applied, succeeding less than `dropBelowRate` of them, leaves. Both are recorded.
export type Settling = { readonly graduateAfter: number; readonly dropAfter: number; readonly dropBelowRate: number; readonly reward: "used" | "ok" | "verdict" }
// `known`: the record's stats, read once per turn by the caller (the sampler uses them too).
export const settle = (dir: string, rules: Settling, session: string, turn: number, known: ReadonlyMap<string, Stats> = stats(dir)) => {
  const none: Stats = { offered: 0, used: 0, ok: 0, helped: 0, applied: 0, notApplied: 0 }
  // Decided and written under the tools lock, from the files as they are now (promote may be adding to them).
  return updateTools(dir, (library, pool) => {
    const graduated = pool.filter((e) => successes(known.get(e.name) ?? none, rules.reward) >= rules.graduateAfter)
    const dropped = pool.filter((e) => {
      const s = known.get(e.name) ?? none
      return !graduated.includes(e) && applicable(s) >= rules.dropAfter && successes(s, rules.reward) < rules.dropBelowRate * applicable(s)
    })
    if (!graduated.length && !dropped.length) return { result: { graduated, dropped } }

    for (const e of graduated) record(dir, { session, turn, tool: e.name, for: e.for, event: "graduated", stats: known.get(e.name) ?? none })
    for (const e of dropped) record(dir, { session, turn, tool: e.name, for: e.for, event: "dropped", stats: known.get(e.name) ?? none })
    return {
      library: [...library.filter((e) => !graduated.some((g) => g.name === e.name)), ...graduated],
      pool: pool.filter((e) => !graduated.includes(e) && !dropped.includes(e)),
      result: { graduated, dropped },
    }
  })
}
