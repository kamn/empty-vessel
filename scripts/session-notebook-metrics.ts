import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"

export type UsageSample = { line?: number; ts: number; input: number; output: number; cached?: number; thinking?: number; model?: string; usageId?: string; system?: "systemOne" | "systemTwo"; agent?: string; provider?: string; granularity?: "provider-result" }
export type UsageResult = { samples: UsageSample[]; source?: string; note: string; systemOneAvailable: boolean; systemTwoAvailable: boolean }
type Metrics = { context?: number; contextTs?: number; input?: number; output?: number; cached?: number; thinking?: number; calls: number }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
const timestamp = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Number.isFinite(new Date(v).getTime())
const subset = (v: unknown, total: number) => count(v) && v <= total
const label = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v)
const epoch = (v: unknown): v is number => count(v) && timestamp(v)
const caveat = "Recorded calls only; total session coverage is not established. Input includes cached tokens; output includes thinking tokens. Context is the last recorded System Two request input, not live context or a window limit."

/** Availability means at least one validated recorded sample, including measured zero.
 * Only this main file and its exact identity-verified mirror are read; no child merging.
 * Stable IDs alone deduplicate calls. ID-less legacy overlap cannot be resolved.
 */
export function loadUsage(source: string): UsageResult {
  const samples: UsageSample[] = [], notes: string[] = []
  let loadedSource: string | undefined
  const finish = (): UsageResult => {
    samples.sort((a, b) => a.ts - b.ts)
    const systemOneAvailable = samples.some(s => s.system === "systemOne")
    return { samples, source: loadedSource, systemOneAvailable, systemTwoAvailable: samples.some(s => s.system === "systemTwo"),
      note: [...notes, ...(!systemOneAvailable ? ["Jev usage unavailable"] : []), caveat].join(" ") }
  }
  const parts = resolve(dirname(source)).split(sep)
  const sessionIndex = parts.lastIndexOf("sessions")
  const ids = parts.slice(sessionIndex + 1)
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (basename(source) !== "main.jsonl" || sessionIndex < 0 || !ids.length || !ids.every(id => uuid.test(id))) {
    notes.push("No matching mirror: expected a UUIDv7 session main.jsonl.")
    return finish()
  }
  const agent = ["sessions", ...ids].join("/")
  const id = ids.at(-1)!.toLowerCase(), parent = ids.at(-2)?.toLowerCase()
  const seen = new Set<string>()
  let invalidMain = 0
  try {
    for (const [index, line] of readFileSync(source, "utf8").split("\n").entries()) {
      if (!line.trim()) continue
      let r: unknown
      try { r = JSON.parse(line) } catch { invalidMain++; continue }
      if (!object(r)) { invalidMain++; continue }
      if (r.role !== "usage") continue
      const u = object(r.extra) ? r.extra : r
      if (r.text !== "model request" || u.usageVersion !== 1 || !epoch(r.ts) || !label(u.usageId) || !label(u.model) ||
        (u.system !== "systemOne" && u.system !== "systemTwo") || u.agent !== agent || !count(u.input) || !count(u.output) ||
        (u.cached !== undefined && !subset(u.cached, u.input)) || (u.thinking !== undefined && !subset(u.thinking, u.output)) ||
        (u.provider !== undefined && !label(u.provider)) || (u.granularity !== undefined && u.granularity !== "provider-result")) {
        invalidMain++; continue
      }
      if (seen.has(u.usageId)) continue
      const sample: UsageSample = { ts: r.ts, line: index + 1, input: u.input, output: u.output, usageId: u.usageId, model: u.model, system: u.system, agent }
      if (u.cached !== undefined) sample.cached = u.cached as number
      if (u.thinking !== undefined) sample.thinking = u.thinking as number
      if (u.provider !== undefined) sample.provider = u.provider as string
      if (u.granularity !== undefined) sample.granularity = "provider-result"
      seen.add(u.usageId); samples.push(sample)
    }
    if (samples.length) loadedSource = source
  } catch (error) {
    notes.push(`Main usage ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable"}; verified mirror fallback allowed.`)
  }
  if (invalidMain) notes.push(`${invalidMain} invalid main records; verified mirror fallback allowed.`)
  const durableTwo = samples.some(s => s.system === "systemTwo")
  const start = new Date(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toISOString()
  const path = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions", ...start.slice(0, 10).split("-"), `rollout-empty-vessel-${start.replaceAll(":", "-")}-${id}.jsonl`)
  let text: string
  try { text = readFileSync(path, "utf8") } catch (error) {
    notes.push(`${(error as NodeJS.ErrnoException).code === "ENOENT" ? "Matching mirror missing" : "Matching mirror unreadable"}.`)
    return finish()
  }
  const records: Record<string, unknown>[] = []
  let malformed = 0, incomplete = 0
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const value: unknown = JSON.parse(line)
      if (!object(value) || typeof value.type !== "string" || !object(value.payload)) { malformed++; continue }
      records.push(value)
    } catch { malformed++ }
  }
  const metas = records.filter(r => r.type === "session_meta")
  if (!metas.length || metas.some(r => {
    const p = r.payload as Record<string, unknown>
    return p.id !== id || p.originator !== "empty-vessel" || p.empty_vessel_parent_session_id !== parent
  })) {
    notes.push(`Mirror rejected: missing or foreign session_meta identity/originator/parent. ${malformed} malformed records.`)
    return finish()
  }
  loadedSource ??= path
  let model: string | undefined, legacy = 0, fallback = 0
  for (const r of records) {
    const p = r.payload as Record<string, unknown>
    if (r.type === "turn_context") model = label(p.model) ? p.model : undefined
    if (r.type !== "event_msg" || p.type !== "token_count") continue
    const u = object(p.info) ? p.info.last_token_usage : undefined
    if (!object(u)) { incomplete++; continue }
    const ts = typeof r.timestamp === "string" && r.timestamp.trim() ? Date.parse(r.timestamp) : NaN
    if (!epoch(ts) || !count(u.input_tokens) || !count(u.output_tokens) || (p.usage_id !== undefined && !label(p.usage_id))) { malformed++; continue }
    if (typeof p.usage_id === "string" && seen.has(p.usage_id)) continue
    const sample: UsageSample = { ts, input: u.input_tokens, output: u.output_tokens, system: "systemTwo", agent, provider: "codex" }
    if (model !== undefined) sample.model = model
    if (typeof p.usage_id === "string") sample.usageId = p.usage_id
    for (const [key, field, total] of [["cached", "cached_input_tokens", sample.input], ["thinking", "reasoning_output_tokens", sample.output]] as const) {
      if (u[field] === undefined) incomplete++
      else if (!subset(u[field], total)) malformed++
      else sample[key] = u[field] as number
    }
    if (sample.usageId) seen.add(sample.usageId)
    else legacy++
    samples.push(sample); fallback++
  }
  if (durableTwo && legacy) notes.push("Unsupported overlap: ID-less legacy mirror calls retained alongside durable System Two usage; totals may double-count overlapping calls. No time/token heuristic applied.")
  if (invalidMain && fallback) notes.push("Valid verified mirror fallback loaded despite invalid primary records.")
  notes.push(`${samples.length ? "Per-call usage loaded." : "No valid per-call usage recorded."} ${malformed} malformed records/counts; ${incomplete} incomplete usage records/fields.`)
  return finish()
}

/** Source-order context state; timestamp-based usage (even for out-of-order rows).
 * Missing optional counts poison that cumulative field, rather than implying zero.
 * Invalid row timestamps yield unknown usage and cannot consume future samples.
 * Tail/output selection belongs to the caller; no synthetic final row is added.
 */
export function metricsAt(rows: ReadonlyArray<{ role: string; text: string; ts?: number; line?: number }>, samples: UsageSample[]): Metrics[] {
  const sorted = samples.filter(s => s && timestamp(s.ts) && count(s.input) && count(s.output)).slice().sort((a, b) => a.ts - b.ts)
  const sums: Metrics[] = []
  let input = 0, output = 0, cached: number | undefined = 0, thinking: number | undefined = 0
  for (const s of sorted) {
    input += s.input; output += s.output
    cached = cached !== undefined && subset(s.cached, s.input) ? cached + s.cached! : undefined
    thinking = thinking !== undefined && subset(s.thinking, s.output) ? thinking + s.thinking! : undefined
    sums.push({ calls: sums.length + 1, input: count(input) ? input : undefined, output: count(output) ? output : undefined,
      cached: count(cached) ? cached : undefined, thinking: count(thinking) ? thinking : undefined })
  }
  let context: number | undefined, contextTs: number | undefined, backend: string | undefined
  return rows.map(row => {
    if (row.role === "compact" || (row.role === "systemTwo" && backend !== undefined && backend !== row.text)) {
      context = undefined; contextTs = undefined
    }
    if (row.role === "systemTwo") backend = row.text
    if (row.role === "size" && /^\d+$/.test(row.text.trim()) && count(Number(row.text))) {
      context = Number(row.text); contextTs = timestamp(row.ts) ? row.ts : undefined
    }
    let lo = 0, hi = sorted.length
    if (timestamp(row.ts)) {
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2)
        if (sorted[mid]!.ts <= row.ts) lo = mid + 1
        else hi = mid
      }
    }
    return { ...(lo ? sums[lo - 1]! : { calls: 0 }), context, contextTs }
  })
}

/** Recorded per-call usage only; cached/thinking are subsets, not extra tokens.
 * Unknown inputs sort last. Explicit model names are preserved except when the
 * unknown label needs disambiguation; grouping never uses a display label.
 */
export function usageByModel(samples: UsageSample[]): Array<{ model: string; calls: number; input?: number; output?: number; cached?: number; thinking?: number }> {
  const groups = new Map<string | undefined, Metrics>()
  const add = (total: number | undefined, value: number | undefined) =>
    count(total) && count(value) && count(total + value) ? total + value : undefined
  for (const s of samples) {
    if (!s || !timestamp(s.ts) || !count(s.input) || !count(s.output)) continue
    const model = typeof s.model === "string" && s.model.trim() ? s.model : undefined
    const totals = groups.get(model) ?? { calls: 0, input: 0, output: 0, cached: 0, thinking: 0 }
    totals.calls++ // Identical records still represent distinct calls.
    totals.input = add(totals.input, s.input)
    totals.output = add(totals.output, s.output)
    totals.cached = add(totals.cached, subset(s.cached, s.input) ? s.cached : undefined)
    totals.thinking = add(totals.thinking, subset(s.thinking, s.output) ? s.thinking : undefined)
    groups.set(model, totals)
  }
  const unknown = "(model not recorded)"
  let collisionLabel = unknown
  if (groups.has(undefined) && groups.has(unknown)) {
    do { collisionLabel += " (recorded model)" } while (groups.has(collisionLabel))
  }
  return Array.from(groups, ([model, totals]) => ({
    model: model === undefined ? unknown : model === unknown ? collisionLabel : model,
    ...totals,
  })).sort((a, b) => (b.input ?? -1) - (a.input ?? -1) || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))
}
