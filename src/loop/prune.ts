import { Effect } from "effect"
import { type Ctx, timed } from "./turnkit"

// ~20-line chunks, at most ~60 of them (one System One question each, all in one call).
export const chunk = (lines: ReadonlyArray<string>) => {
  const size = Math.max(20, Math.ceil(lines.length / 60))
  return Array.from({ length: Math.ceil(lines.length / size) }, (_, i) => lines.slice(i * size, (i + 1) * size))
}

// The kept chunks back together; each run of hidden chunks becomes one "[… N lines hidden …]" marker.
export const stitch = (chunks: ReadonlyArray<ReadonlyArray<string>>, keep: ReadonlyArray<boolean>) => {
  const out: Array<string> = []
  let hidden = 0
  chunks.forEach((c, i) => {
    if (!keep[i]) { hidden += c.length; return }
    if (hidden) out.push(`[… ${hidden} lines hidden by System One …]`)
    hidden = 0
    out.push(...c)
  })
  if (hidden) out.push(`[… ${hidden} lines hidden by System One …]`)
  return out.join("\n")
}

// Long command output: System One scores each chunk and hides the ones it's sure don't help the goal.
// Conservative (hides only below 0.3), and the first and last chunks (the command's start, its verdict) always stay.
export const makePrune = (ctx: Ctx) => (command: string, output: string) =>
  Effect.gen(function* () {
    const chunks = chunk(output.split("\n"))
    const questions = Object.fromEntries(chunks.map((c, i) => [`c${i}`, {
      question: `Would the agent need these lines from the output of \`${command.slice(0, 200)}\` to reach the goal?\n${c.join("\n")}`,
      yes: "Useful: failures, errors, results, or what the goal is about", no: "Noise: passing tests, progress lines, unrelated output",
    }]))

    const { result: { answers } } = yield* timed(ctx, "systemOne", ctx.systemOne.judge({ goal: ctx.input.slice(0, 1000) }, questions))

    const keep = chunks.map((_, i) => i === 0 || i === chunks.length - 1 || (answers[`c${i}`] ?? 1) >= 0.3)
    yield* Effect.logDebug(`system one pruned ${JSON.stringify({ command: command.slice(0, 200), lines: chunks.flat().length, chunks: chunks.length, hidden: keep.filter((k) => !k).length })}`)
    return stitch(chunks, keep)
  })
