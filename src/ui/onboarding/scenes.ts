import { logo } from "../logo"
import { EXAMPLE_COMPARISON } from "./example-comparison"
import { style as S, widthOf } from "../tui/style"

// The onboarding's scenes: a short, recorded walkthrough of empty-vessel's two ideas, shown on
// the first load, before setup. Scripted, with made-up data sized like our real runs: no model is called. Each scene
// draws itself at a moment `t` (ms since it started), within `width` columns; `length` is when its animation ends.

export type Scene = {
  readonly title: string
  readonly length: number
  readonly illustrative?: boolean // its numbers are an example, and the screen says so
  readonly preserveHistory?: boolean // overflow is manually scrollable, never automatically discarded
  readonly draw: (t: number, width: number) => ReadonlyArray<string>
}

// Words wrapped to a width.
export const wrap = (text: string, width: number) => {
  const out: Array<string> = []
  let line = ""

  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && widthOf(`${line} ${word}`) > width) { out.push(line); line = word }
    else line = line ? `${line} ${word}` : word
  }

  return line ? [...out, line] : out
}

// A line cut to `width` columns (colour codes kept, wide characters count 2), with … if it was cut.
export const fit = (line: string, width: number) => {
  if (widthOf(line) <= width) return line
  let out = "", used = 0

  for (const token of line.match(/\x1b\[[0-9;]*m|[^]/gu) ?? []) {
    if (token.startsWith("\x1b")) { out += token; continue }
    const size = widthOf(token)
    if (used + size > width - 1) break
    out += token; used += size
  }

  return `${out}\x1b[0m…`
}

const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - widthOf(text)))
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
const spin = (t: number) => S.dim(SPIN[Math.floor(t / 80) % SPIN.length]!)
const secs = (s: number) => `${s.toFixed(1)} s`
const k = (tokens: number) => `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`

// A paragraph that appears at `at`.
const say = (t: number, at: number, text: string, width: number, paint: (s: string) => string = (s) => s) =>
  t >= at ? wrap(text, width).map(paint) : []

// Steps shown one after another from `start`: each takes `ms`, drawn with its progress (0 to 1) while it runs.
type Step = { readonly ms: number; readonly line: (progress: number, t: number) => string }
const sequence = (t: number, start: number, steps: ReadonlyArray<Step>) => {
  const lines: Array<string> = []
  let at = start

  for (const step of steps) {
    if (t < at) break
    lines.push(step.line(step.ms ? Math.min(1, (t - at) / step.ms) : 1, t))
    at += step.ms
  }

  return { lines, done: t >= at, end: at }
}
const endOf = (start: number, steps: ReadonlyArray<Step>) => sequence(Infinity, start, steps).end

// A model thinking for `seconds` (shown sped up: `scale` ms of screen time per second).
const thinking = (who: string, seconds: number, tokens: number, scale: number, doneNote = ""): Step => ({
  ms: seconds * scale,
  line: (p, t) => p < 1
    ? `${spin(t)} ${who} thinking…  ${S.dim(secs(seconds * p))}`
    : `${S.accent("●")} ${who}  ${secs(seconds)} · ${k(tokens)} tokens${doneNote}`,
})
const shown = (ms: number, text: string): Step => ({ ms, line: () => text })
const ran = (command: string): Step => shown(300, `  ${S.tool("$")} ${command}`)

// ── The task System Two does alone, and with empty-vessel (scenes 1 and 3) ────────────────────────────────────────────

const TASK = "fix the retry bug in the uploader"
// Each round trip: the model thinks (and says what it's after), then runs a command. Its input grows every call: it
// re-reads the whole conversation so far.
const ALONE = [
  { think: 2.6, tokens: 6_100, thought: "Where does uploading happen? Look around.", run: "ls src" },
  { think: 2.4, tokens: 6_900, thought: "There's an upload folder.", run: "ls src/upload" },
  { think: 2.9, tokens: 7_800, thought: "Find where retries happen.", run: "grep -rn retry src/upload" },
  { think: 3.1, tokens: 9_400, thought: "queue.ts schedules retries. Read it.", run: "cat src/upload/queue.ts" },
  { think: 3.3, tokens: 11_200, thought: "It calls backoff(). Read that.", run: "cat src/upload/backoff.ts" },
  { think: 2.8, tokens: 12_600, thought: "Backoff looks fine. Check retry.ts.", run: "cat src/upload/retry.ts" },
  { think: 3.0, tokens: 14_100, thought: "The attempt counter never resets. Fix it." },
] as const
const aloneTime = ALONE.reduce((sum, x) => sum + x.think, 0)
const aloneTokens = ALONE.reduce((sum, x) => sum + x.tokens, 0)
// `thoughts`: each call, then its command, with what the model was after (scene 1); without, one compact line per
// call, its command beside it (the side by side).
const aloneSteps = (scale: number, width: number, thoughts: boolean): ReadonlyArray<Step> =>
  ALONE.flatMap((x): Array<Step> => {
    const then = "run" in x ? `${S.tool("$")} ${x.run}` : `${S.step("✎")} fixes it`
    const call: Step = {
      ms: x.think * scale,
      line: (p, t) => fit(p < 1
        ? `${spin(t)} System Two thinking…  ${S.dim(secs(x.think * p))}`
        : thoughts ? `${S.accent("●")} System Two  ${secs(x.think)}  ${S.dim(S.italic(`“${x.thought}”`))}` : `${S.accent("●")} ${secs(x.think)}  ${then}`, width),
    }
    return thoughts && "run" in x ? [call, ran(x.run)] : [call]
  })

const system1Pick = (what: string, confidence: number) => `${S.step("●")} System One  ${S.bold(what)}  ${S.dim(confidence.toFixed(2))}`

// The logo, centred as a block (its lines keep their shape relative to each other).
const centredLogo = (width: number) => {
  const lines = logo(0, true).split("\n")
  const indent = " ".repeat(Math.max(0, Math.floor((width - Math.max(...lines.map(widthOf))) / 2)))
  return lines.map((l) => (l ? indent + l : l))
}

const welcome: Scene = {
  title: "",
  length: 1200,
  draw: (t, width) => [
    ...centredLogo(width),
    ...say(t, 300, "empty-vessel is a coding agent that uses two kinds of model: the one you know, and a fast one that decides every step.", width),
    "",
    ...say(t, 900, "About two minutes. Enter to begin.", width, S.dim),
  ],
}

const systemTwo: Scene = (() => {
  const start = 1400, scale = 330
  const steps = (width: number) => aloneSteps(scale, width, true)
  const end = endOf(start, steps(78))
  return {
    title: "System Two: the model you know",
    length: end + 900,
    illustrative: true,
    draw: (t, width) => {
      const run = sequence(t, start, steps(width))
      return [
        ...say(t, 0, "You've used models like this one: Claude, GPT, Codex. Give one a task and it works in a loop: think, run a tool, read what came back, think again. Every step is a round trip to the model.", width),
        "",
        ...(t >= 900 ? [`${S.accent("›")} ${S.bold(TASK)}`] : []),
        ...run.lines,
        ...(run.done ? ["", `${S.bold(secs(aloneTime))} and ${S.bold(`${ALONE.length} model calls`)} before the first edit · ${k(aloneTokens)} tokens`] : []),
        ...(t >= end + 900 ? ["", ...wrap("Every small decision is a full model call that re-reads everything.", width).map(S.dim)] : []),
      ]
    },
  }
})()

// ── Snake: System One's quick decisions (scene 2) ──────────────────────────────────────────────────────────────

type Cell = readonly [number, number]
type Dir = "up" | "down" | "left" | "right"
const COLS = 17, ROWS = 8, MOVES = 160, TICK = 160
const DIRS: Readonly<Record<Dir, Cell>> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }
const ARROW: Readonly<Record<Dir, string>> = { up: "↑", down: "↓", left: "←", right: "→" }
// `n`: which decision it is; `crash`: the pick was wrong and the game ended (what it hit).
type Frame = { readonly n: number; readonly snake: ReadonlyArray<Cell>; readonly food: Cell; readonly legal: ReadonlyArray<Dir>; readonly pick?: Dir; readonly confidence: number; readonly ms: number; readonly crash?: string }
const MISTAKE = 104, HOLD = 7 // the decision System One gets wrong (it isn't perfect), and how many ticks the crash shows

// A game worked out once, the same every time (a seeded random): code lists the legal moves; the "pick" heads for
// the food by the shortest free path (standing in for System One's choice), else toward the most room.
export const snakeGame = (): ReadonlyArray<Frame> => {
  let seed = 7
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const key = ([x, y]: Cell) => `${x},${y}`
  const inside = ([x, y]: Cell) => x >= 0 && y >= 0 && x < COLS && y < ROWS
  const step = ([x, y]: Cell, d: Dir): Cell => [x + DIRS[d][0], y + DIRS[d][1]]
  const placeFood = (snake: ReadonlyArray<Cell>): Cell => {
    const taken = new Set(snake.map(key))
    const free = Array.from({ length: COLS * ROWS }, (_, i): Cell => [i % COLS, Math.floor(i / COLS)]).filter((c) => !taken.has(key(c)))
    return free[Math.floor(random() * free.length)]!
  }
  // The first move of a shortest path to `goal` through free cells, if there is one.
  const toward = (snake: ReadonlyArray<Cell>, goal: Cell): Dir | undefined => {
    const blocked = new Set(snake.slice(0, -1).map(key))
    const seen = new Map<string, Dir>()
    const queue: Array<Cell> = []

    for (const d of Object.keys(DIRS) as Array<Dir>) {
      const c = step(snake[0]!, d)
      if (inside(c) && !blocked.has(key(c)) && !seen.has(key(c))) { seen.set(key(c), d); queue.push(c) }
    }

    while (queue.length) {
      const c = queue.shift()!
      if (key(c) === key(goal)) return seen.get(key(c))
      for (const d of Object.keys(DIRS) as Array<Dir>) {
        const n = step(c, d)
        if (inside(n) && !blocked.has(key(n)) && !seen.has(key(n))) { seen.set(key(n), seen.get(key(c))!); queue.push(n) }
      }
    }

    return undefined
  }
  const room = (snake: ReadonlyArray<Cell>, from: Cell) => {
    const blocked = new Set(snake.map(key)), seen = new Set([key(from)]), queue = [from]
    while (queue.length) {
      const c = queue.shift()!
      for (const d of Object.keys(DIRS) as Array<Dir>) { const n = step(c, d); if (inside(n) && !blocked.has(key(n)) && !seen.has(key(n))) { seen.add(key(n)); queue.push(n) } }
    }
    return seen.size
  }

  let snake: ReadonlyArray<Cell> = [[4, 4], [3, 4], [2, 4], [1, 4]]
  let food = placeFood(snake)
  const frames: Array<Frame> = []

  for (let i = 0; i < MOVES; i++) {
    const legal = (Object.keys(DIRS) as Array<Dir>).filter((d) => { const c = step(snake[0]!, d); return inside(c) && !snake.slice(0, -1).some((s) => key(s) === key(c)) })

    // Once, a wrong pick, less sure than usual: into the wall if one is next to the head, else back into itself.
    if (i === MISTAKE) {
      const wrong = (Object.keys(DIRS) as Array<Dir>).find((d) => !inside(step(snake[0]!, d))) ?? (Object.keys(DIRS) as Array<Dir>).find((d) => !legal.includes(d))!
      const crash = inside(step(snake[0]!, wrong)) ? "ran into itself" : "hit the wall"
      const frame: Frame = { n: i + 1, snake, food, legal, pick: wrong, confidence: 0.61, ms: Math.round(88 + random() * 70), crash }
      for (let h = 0; h < HOLD; h++) frames.push(frame)
      snake = [[4, 4], [3, 4], [2, 4], [1, 4]]
      food = placeFood(snake)
      continue
    }

    const pick = toward(snake, food) ?? [...legal].sort((a, b) => room(snake, step(snake[0]!, b)) - room(snake, step(snake[0]!, a)))[0]
    frames.push({ n: i + 1, snake, food, legal, ...(pick ? { pick } : {}), confidence: 0.86 + random() * 0.13, ms: Math.round(88 + random() * 70) })
    if (!pick) { snake = [[4, 4], [3, 4], [2, 4], [1, 4]]; food = placeFood(snake); continue } // boxed in: a new game

    const head = step(snake[0]!, pick)
    const ate = key(head) === key(food)
    snake = [head, ...(ate ? snake : snake.slice(0, -1))]
    if (ate) food = placeFood(snake)
  }

  return frames
}

const board = (f: Frame) => {
  const at = new Map(f.snake.map((c, i) => [`${c[0]},${c[1]}`, i]))
  const rows = Array.from({ length: ROWS }, (_, y) =>
    `│${Array.from({ length: COLS }, (_, x) => {
      const i = at.get(`${x},${y}`)
      if (i === 0) return f.crash ? S.error("✗✗") : S.accent("██")
      if (i !== undefined) return S.step("▓▓")
      return f.food[0] === x && f.food[1] === y ? S.error("◆ ") : "  "
    }).join("")}│`)
  return [`╭${"─".repeat(COLS * 2)}╮`, ...rows, `╰${"─".repeat(COLS * 2)}╯`]
}

const systemOne: Scene = (() => {
  const game = snakeGame()
  const start = 1900
  const end = start + game.length * TICK
  const panel = (f: Frame, i: number) => [
    S.bold("System One"),
    "",
    `${S.dim("legal")}   ${(["up", "left", "down", "right"] as const).filter((d) => f.legal.includes(d)).map((d) => (d === f.pick ? S.accent(`${ARROW[d]} ${d}`) : S.dim(`${ARROW[d]} ${d}`))).join("  ")}`,
    `${S.dim("picks")}   ${f.pick ? (f.crash ? S.error : S.accent)(`${ARROW[f.pick]} ${f.pick}`) : "—"}  ${S.dim(f.confidence.toFixed(2))}`,
    `${S.dim("took")}    ${f.ms} ms`,
    f.crash ? S.error(`✗ wrong move: ${f.crash}`) : "",
    `${S.dim("moves")}   ${f.n}`,
    `${S.dim("average")} ${Math.round(game.slice(0, i + 1).reduce((s, g) => s + g.ms, 0) / (i + 1))} ms a decision`,
  ]
  return {
    title: "System One: quick decisions",
    length: end + 700,
    illustrative: true,
    draw: (t, width) => {
      const i = Math.max(0, Math.min(game.length - 1, Math.floor((t - start) / TICK)))
      const lines = t >= start ? board(game[i]!) : []
      const side = t >= start ? panel(game[i]!, i) : []
      const beside = width >= COLS * 2 + 2 + 3 + 30
      const play = beside
        ? lines.map((l, r) => `${l}   ${side[r - 1] ?? ""}`)
        : [...lines, "", ...side]
      return [
        ...say(t, 0, "empty-vessel adds a second kind of model. System One doesn't write or reason at length: it picks. Show it a situation and a few options, and it chooses one, with how sure it is, in about a tenth of a second. Today that's Jev, from TypeSafe AI; another fast judge could take its place.", width),
        "",
        ...play,
        ...(t >= end ? ["", ...wrap("Code lists the legal moves. System One picks one. It isn't perfect: once it picked a move that wasn't legal, less sure than usual, and crashed. But it's right almost every time, and fast enough to steer a game, and an agent.", width).map(S.dim)] : []),
      ]
    },
  }
})()

// ── The Gather tool: System One finding the context (scene 3) ──────────────────────────────────────────────────

// The walk, as src/system-one/explore.ts does it: a best-first search. System One scores each entry (how likely it is
// to matter for the task); code always takes the best item next: it opens a folder (scoring what's inside), searches
// for the task's words, peeks at promising files (their first lines, scored again), and picks what still scores high.
type Row = { readonly path: string; readonly depth: number; readonly name: string; readonly folder?: true }
const TREE: ReadonlyArray<Row> = [
  { path: ".", depth: 0, name: "your project", folder: true },
  { path: "src", depth: 1, name: "src", folder: true },
  { path: "src/upload", depth: 2, name: "upload", folder: true },
  { path: "src/upload/retry.ts", depth: 3, name: "retry.ts" },
  { path: "src/upload/queue.ts", depth: 3, name: "queue.ts" },
  { path: "src/upload/client.ts", depth: 3, name: "client.ts" },
  { path: "src/upload/backoff.ts", depth: 3, name: "backoff.ts" },
  { path: "src/upload/types.ts", depth: 3, name: "types.ts" },
  { path: "src/auth", depth: 2, name: "auth", folder: true },
  { path: "src/ui", depth: 2, name: "ui", folder: true },
  { path: "src/index.ts", depth: 2, name: "index.ts" },
  { path: "test", depth: 1, name: "test", folder: true },
  { path: "test/upload.test.ts", depth: 2, name: "upload.test.ts" },
  { path: "README.md", depth: 1, name: "README.md" },
  { path: "package.json", depth: 1, name: "package.json" },
]
type Move = { readonly move: string; readonly note: string; readonly at: ReadonlyArray<string>; readonly scores: Readonly<Record<string, number>>; readonly shows?: ReadonlyArray<string>; readonly picks?: ReadonlyArray<string> }
const MOVES_TAKEN: ReadonlyArray<Move> = [
  { move: "open your project", at: ["."], scores: { src: 0.91, test: 0.42, "README.md": 0.2, "package.json": 0.12 },
    note: "It opens the top folder. System One scores every entry: how likely is it to matter for this task?" },
  { move: "search: retry, upload", at: ["src/upload/retry.ts", "test/upload.test.ts"], shows: ["src/upload"], scores: { "src/upload/retry.ts": 0.88, "test/upload.test.ts": 0.46 },
    note: "It searches for the task's words. Files that contain several of them join the list, scored too." },
  { move: "open src  0.91", at: ["src"], scores: { "src/upload": 0.95, "src/auth": 0.06, "src/ui": 0.11, "src/index.ts": 0.22 },
    note: "Code always takes the best-scored item next. Low scores are never opened." },
  { move: "open upload  0.95", at: ["src/upload"], scores: { "src/upload/queue.ts": 0.83, "src/upload/client.ts": 0.64, "src/upload/backoff.ts": 0.58, "src/upload/types.ts": 0.31 },
    note: "The most promising folder. Its files are scored by their names." },
  { move: "peek 4 files", at: ["src/upload/retry.ts", "src/upload/queue.ts", "src/upload/client.ts", "src/upload/backoff.ts"], scores: { "src/upload/retry.ts": 0.97, "src/upload/queue.ts": 0.86, "src/upload/client.ts": 0.41, "src/upload/backoff.ts": 0.52 },
    note: "It reads the first 30 lines of the best files, and System One scores them again, now from what's in them." },
  { move: "pick retry.ts, queue.ts", at: [], picks: ["src/upload/retry.ts", "src/upload/queue.ts"], scores: {},
    note: "It keeps what still scores high. Everything else stays out of System Two's context." },
]
// It plays twice: slowed down, each move held long enough to read (the clock shows the walk's real time, ticking
// slowly), then again at real speed: the whole walk in 0.9 s.
const REAL = 0.9, SLOW_MS = 1700, FAST_MS = (REAL * 1000) / MOVES_TAKEN.length, BETWEEN = 2200

const gather: Scene = (() => {
  const slowStart = 1600, slowEnd = slowStart + MOVES_TAKEN.length * SLOW_MS
  const fastStart = slowEnd + BETWEEN, fastEnd = fastStart + MOVES_TAKEN.length * FAST_MS
  const slower = Math.round(SLOW_MS / FAST_MS)
  const score = (v: number | undefined) => (v === undefined ? "" : v >= 0.5 ? S.step(v.toFixed(2)) : S.dim(v.toFixed(2)))

  // The tree and the move log after `done` moves (`finished`: the last one is over, nothing is being worked on).
  const walk = (done: number, finished: boolean, width: number, notes: (now: Move | undefined) => ReadonlyArray<string>) => {
    const taken = MOVES_TAKEN.slice(0, done)
    const scores: Record<string, number> = {}
    const seen = new Set(["."]), picked = new Set<string>(), opened = new Set<string>(["."])
    for (const m of taken) if (m.move.startsWith("open")) for (const p of m.at) opened.add(p)
    for (const m of taken) { Object.assign(scores, m.scores); for (const p of [...Object.keys(m.scores), ...(m.shows ?? [])]) seen.add(p); for (const p of m.picks ?? []) picked.add(p) }
    const now = finished ? undefined : taken.at(-1)

    const tree = TREE.filter((r) => seen.has(r.path)).map((r) => {
      const here = now?.at.includes(r.path) ?? false
      const name = `${"  ".repeat(r.depth)}${r.folder ? (opened.has(r.path) ? "▾ " : "▸ ") : "  "}${r.name}`
      const mark = picked.has(r.path) ? ` ${S.tool("✓")}` : ""
      return `${here ? S.accent("›") : " "} ${pad(here ? S.bold(name) : name, 24)} ${score(scores[r.path])}${mark}`
    })
    const log = taken.map((m, i) => `${S.dim(`${i + 1}`)} ${m === now ? S.accent(m.move) : m.move}`)
    const panelWidth = width - 36 - 3
    const panel = [
      S.bold("System One, move by move"),
      "",
      ...log,
      ...(finished ? [`${S.tool("✓")} ${S.bold("2 files")} · 5 calls · ${REAL} s`] : []),
      "",
      ...notes(now).flatMap((n) => wrap(n, Math.max(20, panelWidth))).map(S.dim),
    ]
    return panelWidth >= 28
      ? Array.from({ length: Math.max(tree.length, panel.length) }, (_, i) => `${pad(tree[i] ?? "", 36)}   ${panel[i] ?? ""}`)
      : [...tree, "", ...panel.map((l) => fit(l, width))]
  }
  const clock = (seconds: number, note: string) => `${S.accent("⏱")} ${S.bold(`${seconds.toFixed(2)} s`)}  ${S.dim(note)}`

  return {
    title: "The Gather tool",
    length: fastEnd + 1500,
    illustrative: true,
    draw: (t, width) => {
      const intro = say(t, 0, "Gather is System One's first tool. Before System Two starts, System One walks your project and picks the files that matter, one quick decision at a time.", width)
      // The task, with the clock beside it once the walk starts.
      const task = (clockLine?: string) => {
        if (t < 700) return []
        const line = `${S.accent("›")} ${S.bold(TASK)}`
        if (!clockLine) return [line, ""]
        return widthOf(`${line}     ${clockLine}`) <= width ? [`${line}     ${clockLine}`, ""] : [line, clockLine, ""] // narrow: its own line
      }

      // Slowed down: a move every SLOW_MS, each explained.
      if (t < fastStart) {
        const done = t >= slowStart ? Math.min(MOVES_TAKEN.length, Math.floor((t - slowStart) / SLOW_MS) + 1) : 0
        const finished = t >= slowEnd
        const seconds = Math.min(REAL, Math.max(0, (t - slowStart) / (slowEnd - slowStart)) * REAL)
        const notes = (now: Move | undefined) => (finished ? ["That was slowed down. Now the same walk at real speed…"] : now ? [now.note] : [])
        return [...intro, "", ...task(t >= slowStart ? clock(seconds, `slowed down ${slower}×`) : undefined), ...walk(done, finished, width, notes)]
      }

      // Real speed: the whole walk in 0.9 s.
      const done = Math.min(MOVES_TAKEN.length, Math.floor((t - fastStart) / FAST_MS) + 1)
      const finished = t >= fastEnd
      const seconds = Math.min(REAL, (t - fastStart) / 1000)
      const notes = () => (finished ? ["That's real speed. System Two gets these 2 files in its first message."] : ["Real speed."])
      return [...intro, "", ...task(clock(seconds, "real speed")), ...walk(done, finished, width, notes)]
    },
  }
})()

const sideBySide: Scene = {
  title: "Side by side", illustrative: true, preserveHistory: true, length: 1200 + Math.max(EXAMPLE_COMPARISON.baseline.wallMs, EXAMPLE_COMPARISON.harness.wallMs) / EXAMPLE_COMPARISON.speed + 1200,
  draw: (t, width) => {
    const r = EXAMPLE_COMPARISON, elapsed = Math.max(0, t - 1200) * r.speed
    const col = Math.floor((width - 3) / 2), beside = col >= 34, w = beside ? col : width
    const panel = (run: typeof r.baseline | typeof r.harness) => {
      const done = elapsed >= run.wallMs, events = run.events.filter(e => e.at <= elapsed)
      const paint = (text: string) => (text.startsWith("✗") ? S.error : text.startsWith("✎") ? S.accent : text.startsWith("✓") ? S.step : S.tool)(text)
      const lines = events.map(e => fit(`${S.dim(`${(e.at / 1000).toFixed(1).padStart(5)}s`)} ${paint(e.text)}`, w))

      return [
        S.bold(run.name), S.dim("─".repeat(w)), ...lines,
        ...(beside ? [fit(S.dim(`  ↳ ${events.at(-1)?.detail ?? "Waiting for the first tool call"}`), w)] : []),
        done ? S.step(`✓ finished · ${secs(run.wallMs / 1000)}`) : `${spin(t)} working · ${secs(Math.min(elapsed, run.wallMs) / 1000)}`,
        ...(beside ? [done ? S.dim(`${k(run.inputTokens)} input · ${k(run.cachedInputTokens)} cached`) : ""] : []),
        done ? (run.failed ? S.error : S.step)(`tests: ${run.passed} pass · ${run.failed} fail`) : S.dim("tests pending"),
      ]
    }
    const a = panel(r.baseline), b = panel(r.harness)

    return [
      ...wrap(`› ${r.title}`, width).map(S.bold), S.dim(`Illustrative · simulated task · ${r.speed}×`), "",
      ...(beside ? Array.from({ length: Math.max(a.length, b.length) }, (_, i) => `${pad(a[i] ?? "", col)} ${S.dim("│")} ${b[i] ?? ""}`) : [...a, "", ...b]), "",
      ...wrap("Made-up steps and timings · not a benchmark", width).map(S.dim),
    ]
  },
}

// ── The tool cycle, with tickets (scenes 4 and 5) ──────────────────────────────────────────────────────────────

const ASK = "which of my tickets are urgent, and who should take them?"
const bar = (p: number, n: number) => `${S.accent("█".repeat(Math.round(p * 20)))}${S.dim("░".repeat(20 - Math.round(p * 20)))} ${Math.round(p * n)}/${n}`

const firstTime: Scene = (() => {
  const start = 1300, scale = 110
  const steps: ReadonlyArray<Step> = [
    shown(0, S.bold("empty-vessel, the first time")),
    shown(400, `${system1Pick("escalate", 0.91)}  ${S.dim("a new kind of request")}`),
    thinking("System Two", 4.1, 9_000, scale, "  writes a short program:"),
    shown(250, `  ${S.dim("│")} ${S.code("const all = yield* tickets")}`),
    shown(250, `  ${S.dim("│")} ${S.code("return yield* judge(all, show, { urgency, team })")}`),
    { ms: 1800, line: (p) => (p < 1 ? `${S.step("●")} System One  judging  ${bar(p, 30)}` : `${S.step("●")} System One  judged 30 tickets · 8 at a time · 3.4 s`) },
    shown(900, `  answered in ${S.bold("8.0 s")} · 9.0k System Two tokens`),
    // You ask for it to be kept: System Two promotes its code, and empty-vessel checks it before System One gets it.
    shown(0, ""),
    { ms: 1500, line: (p) => `${S.accent("›")} ${S.bold("save that as a tool System One can use".slice(0, Math.ceil(p * 38)))}${p < 1 ? S.accent("▏") : ""}` },
    shown(700, `${S.accent("●")} System Two  ${S.code(`promote("triageTickets", …)`)}`),
    shown(350, `  ${S.tool("✓")} runs on an example`),
    shown(350, `  ${S.tool("✓")} does what its description says`),
    shown(400, `  ${S.tool("✓")} System One can tell when to use it`),
    shown(0, `  → on trial: one of System One's options`),
  ]
  const end = endOf(start, steps)
  return {
    title: "Code becomes a tool",
    length: end + 800,
    illustrative: true,
    draw: (t, width) => [
      ...say(t, 0, "When System Two solves something with code, you can keep the code as a tool for System One.", width),
      "",
      ...(t >= 700 ? [`${S.accent("›")} ${S.bold(ASK)}`, S.dim("  30 tickets · a model alone: 38 s, 46k tokens, every time"), ""] : []),
      ...sequence(t, start, steps).lines,
    ],
  }
})()

// The next time: System One's options for the request (like the snake's legal moves), the tool it picks running, and
// the answer; then the loop the tool came from, going round.
const OPTIONS = [["escalate to System Two", 0.07], ["gather files", 0.11], ["triageTickets", 0.98]] as const
const URGENT = [["T-104", "Checkout is down for EU customers", "bug"], ["T-117", "Charged twice after the price change", "billing"], ["T-121", "Can't log in after a password reset", "login"]] as const
const STAGES = ["System Two solves it", "you promote it", "System One uses it next time"] as const

// The loop as a ring, the stage `lit` highlighted: two across the top (left to right), the third along the bottom
// (back to the start), joined at the ends.
const ring = (lit: number) => {
  const paint = (i: number) => (i === lit ? S.accent(S.bold(STAGES[i]!)) : STAGES[i]!)
  const top = `╭─→ ${paint(0)} ─→ ${paint(1)} ─`, bottom = `╰── ${paint(2)} ←─`
  const inner = Math.max(widthOf(top), widthOf(bottom))
  const close = (line: string, fill: string, end: string) => `${line}${S.dim(fill.repeat(inner - widthOf(line)))}${end}`
  return [close(top, "─", "╮"), `│${" ".repeat(inner - 1)}│`, close(bottom, "─", "╯")]
}

const nextTime: Scene = (() => {
  const ask = 900, choose = 1700, run = 3300, answer = 4700, loop = 6500
  return {
    title: "The next time",
    length: loop + 4 * 900 + 600,
    illustrative: true,
    draw: (t, width) => {
      const scoring = Math.min(1, Math.max(0, (t - choose) / 1200))
      const options = t >= choose ? OPTIONS.map(([name, score]) => {
        const shownScore = score * scoring
        const picked = scoring >= 1 && score > 0.5
        const barWidth = Math.round(shownScore * 12)
        return `  ${pad(picked ? S.accent(S.bold(name)) : name, 24)} ${picked ? S.accent("█".repeat(barWidth)) : S.dim("█".repeat(barWidth))}${" ".repeat(12 - barWidth)} ${S.dim(shownScore.toFixed(2))}${picked ? S.accent("  ← picks") : ""}`
      }) : []
      const running = Math.min(1, Math.max(0, (t - run) / 1200))
      return [
        ...say(t, 0, "The same kind of request, in other words. System One has a new option now, and it's the right one.", width),
        "",
        ...(t >= ask ? [`${S.accent("›")} ${S.bold("anything urgent in my tickets?")}`, ""] : []),
        ...options,
        ...(t >= run ? ["", running < 1 ? `${S.step("●")} System One runs triageTickets  ${bar(running, 30)}` : `${S.step("●")} System One ran triageTickets: ${S.bold("3 urgent")} of 30`] : []),
        ...(t >= answer ? URGENT.map(([id, what, team]) => `  ${S.accent(id)}  ${pad(what, 38)} ${S.dim(team)}`) : []),
        ...(t >= answer ? [`  3.1 s · ${S.accent("System Two not called")}`] : []),
        ...(t >= loop ? ["", ...ring(Math.floor((t - loop) / 900) % STAGES.length)] : []),
      ]
    },
  }
})()

const end: Scene = {
  title: "That's empty-vessel",
  length: 1500,
  draw: (t, width) => [
    ...say(t, 0, "System One decides every step. System Two thinks when it's needed.", width, S.bold),
    ...say(t, 300, "What System Two solves, you can promote to a tool System One uses next time.", width, S.bold),
    "",
    ...(t >= 900 ? [
      "Next, connect the two:",
      `  ${pad(S.accent("System One"), 13)}a Jev key, from typesafe.ai`,
      `  ${pad(S.accent("System Two"), 13)}a Codex login (codex login), or Claude Code`,
      "",
      S.dim("empty-vessel onboarding shows this again."),
    ] : []),
  ],
}

export const SCENES: ReadonlyArray<Scene> = [welcome, systemTwo, systemOne, gather, sideBySide, firstTime, nextTime, end]
