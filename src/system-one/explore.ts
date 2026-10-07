import { Effect } from "effect"
import type { Tokens } from "../base/usage"
import { Kernel } from "../tools/kernel-service"
import { SystemOne } from "./systemone"

// Gather reads the project through the kernel (src/tools/kernel-service.ts): the files the cells see, not this
// machine's, when they differ. Every file in the project that git tracks (so gitignored build output is left out), or,
// outside a git repo, every file except .git/ and node_modules/. Never fails: at worst, an empty list.
export const projectFiles = (root: string) => Effect.gen(function* () { return yield* (yield* Kernel).files.list(root) })

// What System One is shown at one level of the tree: folders (how many files anywhere below, and a few names directly
// inside, as a hint) and files. Code does the counting; System One only judges.
export type Entry =
  | { readonly kind: "folder"; readonly path: string; readonly files: number; readonly sample: ReadonlyArray<string> }
  | { readonly kind: "file"; readonly path: string }

const SAMPLE = 6 // names shown per folder

// Words from the goal worth searching for: identifiers and words of 4+ letters, minus common English and issue boilerplate.
const STOP = new Set(["that", "this", "with", "from", "when", "what", "which", "where", "there", "their", "then", "than", "have", "does",
  "should", "would", "could", "only", "into", "your", "some", "will", "also", "just", "like", "been", "being", "were", "they",
  "resolve", "issue", "github", "repository", "folder", "change", "source", "code", "tests", "test", "existing", "working", "works"])
const goalWords = (goal: string) =>
  [...new Set((goal.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []).map((w) => w.toLowerCase()).filter((w) => !STOP.has(w)))]

// A file or folder name matches if its stem contains a goal word ("duration" ⊂ "duration", "computed" ⊂ "apiComputed.ts").
const matches = (name: string, words: ReadonlyArray<string>) => {
  const stem = name.toLowerCase().replace(/\.[a-z]+$/, "")
  return words.some((w) => stem.includes(w))
}

// How an entry is put to System One: "folder packages/reactivity/src (13 files: computed.ts, dep.ts, …)" or "file README.md".
export const describe = (e: Entry) => (e.kind === "folder" ? `folder ${e.path} (${e.files} files: ${e.sample.join(", ")}…)` : `file ${e.path}`)

export const listLevel = (files: ReadonlyArray<string>, dir: string, words: ReadonlyArray<string> = []): Array<Entry> => {
  const prefix = dir ? `${dir}/` : ""
  const folders = new Map<string, { files: number; sample: Set<string> }>()
  const here: Array<Entry> = []
  for (const file of files) {
    if (!file.startsWith(prefix)) continue
    const rest = file.slice(prefix.length)
    const slash = rest.indexOf("/")
    if (slash === -1) { here.push({ kind: "file", path: file }); continue }
    const folder = folders.get(rest.slice(0, slash)) ?? { files: 0, sample: new Set<string>() }
    folder.files++
    folder.sample.add(rest.slice(slash + 1).split("/")[0]!) // all names here; trimmed below
    folders.set(rest.slice(0, slash), folder)
  }

  // The sample shows names matching the goal first, so "plugin (37 files: duration, …)" isn't hidden behind "advancedFormat…".
  const sample = (names: Set<string>) => [...names].sort((a, b) => Number(matches(b, words)) - Number(matches(a, words))).slice(0, SAMPLE)
  const shown = [...folders].map(([name, f]): Entry => ({ kind: "folder", path: prefix + name, files: f.files, sample: sample(f.sample) }))
  return [...shown, ...here]
}

// Files containing the most distinct goal words (git grep). Words found in too many files say nothing and are skipped.
const MAX_HITS = 8, COMMON = 40
const searchHits = (root: string, words: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { files } = yield* Kernel
    const count = new Map<string, number>()
    for (const w of words) {
      const hits = yield* files.grep(root, w)
      if (hits.length <= COMMON) for (const f of hits) count.set(f, (count.get(f) ?? 0) + 1)
    }
    return [...count].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, MAX_HITS).map(([f, n]) => ({ path: f, n }))
  })

const OPEN_AT = 0.5 // a folder or file below this isn't worth a look
const PICK_AT = 0.6 // a peeked file needs this to go in the pack
const PEEK_LINES = 100 // the first 30 lines are often only imports and constants (16 calls, 30 → 100 lines found 68% → 75% in dayjs)
const PEEK_BATCH = 8 // files peeked per System One call
const MAX_CALLS = 16 // ponytail: fixed; one call ≈ 0.15s. At 8, 92 of 104 Multi-SWE tasks ran out
const BUDGET_BYTES = 50_000

type Item = { readonly entry: Entry; score: number; peeked: boolean }

// Best-first search with System One as the guide: one queue across all levels; code always takes the best item.
// A folder is opened (its contents scored), a file is peeked (its first lines scored), a peeked file that still
// scores well is picked. Stops at MAX_CALLS, a full budget, or when nothing left is worth a look.
// `limits`: to try other budgets; the defaults are the constants above.
export const explore = (root: string, goal: string, limits: { readonly calls?: number; readonly peekLines?: number } = {}) =>
  Effect.gen(function* () {
    const one = yield* SystemOne
    const files = yield* projectFiles(root)

    const queue: Array<Item> = [], picked: Array<string> = [], moves: Array<string> = []
    const seen = new Set<string>() // every path queued once, whether found by search or by opening its folder
    const add = (entry: Entry, score: number) => { if (!seen.has(entry.path)) { seen.add(entry.path); queue.push({ entry, score, peeked: false }) } }

    const maxCalls = limits.calls ?? MAX_CALLS, peekLines = limits.peekLines ?? PEEK_LINES
    const tokens = { input: 0, output: 0 }
    let calls = 0, used = 0
    const ask = (items: ReadonlyArray<string>) =>
      one.relevant(goal, items).pipe(Effect.tap((r) => Effect.sync(() => { calls++; tokens.input += r.tokens.input; tokens.output += r.tokens.output })))

    const words = goalWords(goal)
    const open = (dir: string) => Effect.gen(function* () {
      const entries = listLevel(files, dir, words)
      const { scores } = yield* ask(entries.map(describe))
      entries.forEach((entry, i) => add(entry, scores[i] ?? 0))
    })

    yield* open("")

    // Search as a move: files that contain several goal words, scored by System One in one call, join the queue directly.
    const hits = yield* searchHits(root, words)
    if (hits.length) {
      const { scores } = yield* ask(hits.map((h) => `file ${h.path} (contains ${h.n} words from the goal)`))
      hits.forEach((h, i) => add({ kind: "file", path: h.path }, scores[i] ?? 0))
      moves.push(`search ${hits.map((h, i) => `${h.path} → ${(scores[i] ?? 0).toFixed(2)}`).join(", ")}`)
    }

    while (calls < maxCalls && used < BUDGET_BYTES) {
      queue.sort((a, b) => b.score - a.score)
      const best = queue[0]
      if (!best || best.score < OPEN_AT) break

      if (best.entry.kind === "folder") { queue.shift(); moves.push(`open ${best.entry.path} (${best.score.toFixed(2)})`); yield* open(best.entry.path); continue }
      if (best.peeked) {
        queue.shift()
        const bytes = yield* (yield* Kernel).files.size(root, best.entry.path)
        if (best.score >= PICK_AT && used + bytes <= BUDGET_BYTES) { picked.push(best.entry.path); used += bytes; moves.push(`pick ${best.entry.path} (${best.score.toFixed(2)})`) }
        continue
      }

      // Peek at the most promising files still unread, together: their first lines, scored again from the content.
      const batch = queue.filter((q) => q.entry.kind === "file" && !q.peeked && q.score >= OPEN_AT).slice(0, PEEK_BATCH)
      const { files } = yield* Kernel
      const heads = yield* Effect.forEach(batch, (q) => files.read(root, q.entry.path).pipe(Effect.map((t) => (t ?? "").split("\n").slice(0, peekLines).join("\n"))), { concurrency: "unbounded" })
      const { scores } = yield* ask(batch.map((q, i) => `file ${q.entry.path}, which starts:\n${heads[i]}`))
      batch.forEach((q, i) => { q.score = scores[i] ?? 0; q.peeked = true })
      moves.push(`peek ${batch.map((q) => `${q.entry.path} → ${q.score.toFixed(2)}`).join(", ")}`)
    }

    yield* Effect.logDebug(`explore ${JSON.stringify({ calls, picked, moves })}`)
    return { picked, moves, calls, tokens: tokens as Tokens }
  })

// The picked files as one block for System Two's first prompt.
export const packFiles = (root: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { files } = yield* Kernel
    const texts = yield* Effect.forEach(paths, (path) => files.read(root, path), { concurrency: "unbounded" })
    return paths.map((path, i) => `<file path="${path}">\n${texts[i] ?? ""}\n</file>`).join("\n\n")
  })
