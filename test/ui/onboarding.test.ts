import { expect, test } from "bun:test"
import { widthOf } from "../../src/ui/tui/style"
import { firstLoad, screen } from "../../src/ui/onboarding/player"
import { SCENES, snakeGame } from "../../src/ui/onboarding/scenes"
import { EXAMPLE_COMPARISON as R } from "../../src/ui/onboarding/example-comparison"

test("every scene, at every moment of its animation, fits its width (78, and 60 for a narrow terminal)", () => {
  for (const width of [78, 60]) for (const scene of SCENES) for (let t = 0; t <= scene.length + 2000; t += 50) {
    const wide = scene.draw(t, width).filter((l) => widthOf(l) > width)
    expect({ scene: scene.title, t, width, wide }).toEqual({ scene: scene.title, t, width, wide: [] })
  }
})

test("a whole screen fits an 80 by 24 terminal, keys at the bottom; the last scene offers setup", () => {
  for (const [i, scene] of SCENES.entries()) for (const t of [0, scene.length / 2, scene.length]) {
    const lines = screen(SCENES, i, t, 80, 24)
    expect(lines.length).toBeLessThanOrEqual(24)
    expect(lines.every((l) => widthOf(l) <= 80)).toBe(true)
  }
  expect(screen(SCENES, SCENES.length - 1, Infinity, 80, 24).at(-1)).toContain("set up now")
  // Narrower than the scenes are laid out for: lines are cut, never wrapped onto the next row.
  for (const [i, scene] of SCENES.entries()) expect(screen(SCENES, i, scene.length, 44, 24).every((l) => widthOf(l) <= 44)).toBe(true)
})

test("the snake game: one wrong pick (not a legal move, less sure) that crashes; otherwise it never boxes itself in, and eats", () => {
  const game = snakeGame()
  const wrong = game.filter((f) => f.crash)
  expect(new Set(wrong.map((f) => f.n)).size).toBe(1) // one decision, shown for a few ticks
  expect(wrong.every((f) => !f.legal.includes(f.pick!) && f.confidence < 0.7)).toBe(true)
  expect(game.filter((f) => !f.crash).every((f) => f.pick !== undefined && f.legal.includes(f.pick))).toBe(true)
  expect(game.at(-1)!.snake.length).toBeGreaterThan(4) // the new game after the crash eats too
})

test("the first load shows it only when interactive, without --prompt, before setup, and once", () => {
  const base = { interactive: true, prompt: false, configured: false, shown: false }
  expect(firstLoad(base)).toBe(true)
  expect(firstLoad({ ...base, interactive: false })).toBe(false)
  expect(firstLoad({ ...base, prompt: true })).toBe(false)
  expect(firstLoad({ ...base, configured: true })).toBe(false)
  expect(firstLoad({ ...base, shown: true })).toBe(false)
})

test("the replay retains early steps, independent endings, and manually scrollable overflow", () => {
  const i = SCENES.findIndex(s => s.title === "Side by side"), scene = SCENES[i]!
  const body = scene.draw(Infinity, 100).map(l => l.replace(/\x1b\[[0-9;]*m/g, ""))

  for (const text of [R.harness.events[0].text, R.baseline.events[0].text]) expect(body.join("\n")).toContain(text)
  const endRow = (ms: number) => body.findIndex(l => l.includes(`finished · ${(ms / 1000).toFixed(1)} s`))
  expect(endRow(R.harness.wallMs) - endRow(R.baseline.wallMs)).toBe(R.harness.events.length - R.baseline.events.length)
  expect(screen(SCENES, i, Infinity, 80, 24).join("\n")).toContain("System One gathers")
  expect(screen(SCENES, i, Infinity, 80, 24, 10000).join("\n")).toContain(`finished · ${(R.baseline.wallMs / 1000).toFixed(1)} s`)
})

test("the comparison is explicitly illustrative, not a recorded benchmark", () => {
  const scene = SCENES.find(s => s.title === "Side by side")!
  expect(scene.illustrative).toBe(true)
  expect(R.speed).toBe(8)
  const body = scene.draw(Infinity, 120).join("\n")

  for (const run of [R.baseline, R.harness]) for (const e of run.events) expect(body).toContain(e.text)
  for (const t of [0, scene.length / 2, Infinity]) expect(scene.draw(t, 80).join("\n")).toContain("Illustrative")
  expect(body).toContain("not a benchmark")
  for (const text of ["Vue #", "Recorded", "faster here", "hidden tests", "gpt-6"]) expect(body).not.toContain(text)
})
