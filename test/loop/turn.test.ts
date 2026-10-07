import { expect, test } from "bun:test"
import { Effect } from "effect"
import { chunk, stitch } from "../../src/loop/prune"
import { finalReply, isFinished } from "../../src/loop/turn"
import { handOver, onceNotes } from "../../src/loop/steps"
import { newConversation } from "../../src/loop/turnkit"

test("isFinished: never before a step; System Two's answer ends the turn unless System One is sure it isn't done; questions are never sent back", () => {
  expect(isFinished(0, 0.9, false, false).finished).toBe(false) // no reply this turn yet (only gathering or a failed tool: the caller passes 0)
  expect(isFinished(1, 0.6, false, false).finished).toBe(true) // System One says done
  expect(isFinished(1, 0.3, false, false).finished).toBe(false) // not System Two, System One unsure
  expect(isFinished(1, 0.3, true, false)).toEqual({ vetoed: false, finished: true }) // System Two answered, System One not sure it isn't done
  expect(isFinished(1, 0.1, true, false)).toEqual({ vetoed: true, finished: false }) // System One sure it isn't done: veto
  expect(isFinished(1, 0.1, true, true)).toEqual({ vetoed: false, finished: true }) // a question for the user: never sent back
})

test("finalReply: an answer beats the last step's result; the step limit is noted", () => {
  expect(finalReply("the answer", "loaded a.ts", false)).toBe("the answer")
  expect(finalReply(undefined, "loaded a.ts", false)).toBe("loaded a.ts")
  expect(finalReply(undefined, "loaded a.ts", true)).toBe("loaded a.ts (step limit)")
})

test("chunk and stitch: ~20-line chunks; hidden runs become one marker", () => {
  const lines = Array.from({ length: 65 }, (_, i) => `line ${i + 1}`)
  const chunks = chunk(lines)
  expect(chunks.map((c) => c.length)).toEqual([20, 20, 20, 5])
  const text = stitch(chunks, [true, false, false, true])
  expect(text.split("\n")).toEqual([...lines.slice(0, 20), "[… 40 lines hidden by System One …]", ...lines.slice(60)])
  expect(chunk(Array.from({ length: 3000 }, () => "x")).length).toBe(60) // long output: bigger chunks, at most ~60
})

test("handOver: a ticket list System One printed reaches System Two; a long one is shortened, the rest kept for more_output", async () => {
  const tickets = (n: number) => Array.from({ length: n }, (_, i) => `PROJ-${i + 1}  Open  High  Checkout fails on retry ${i + 1}`).join("\n")
  const unseen = [{ user: "list my open Jira tickets", answer: tickets(30) }]
  const keepFirst = (_: string, out: string) => Effect.succeed(`${out.split("\n")[0]}\n[… hidden …]`)

  const stash = new Map<string, string>()
  const short = await Effect.runPromise(handOver(unseen, keepFirst, stash))
  expect(short).toContain("System One handled these on its own")
  expect(short).toContain("User: list my open Jira tickets")
  expect(short).toContain("PROJ-30") // 30 tickets fit: all of them, nothing stashed
  expect(stash.size).toBe(0)

  const long = await Effect.runPromise(handOver([{ ...unseen[0]!, answer: tickets(300) }], keepFirst, stash))
  expect(long).not.toContain("PROJ-300")
  expect(long).toContain('more_output { id: "out1" }')
  expect(stash.get("out1")).toContain("PROJ-300")

  expect(await Effect.runPromise(handOver([], keepFirst, stash))).toBe("")
})

test("onceNotes: a resume's older cells and a takeover note reach System Two's first run, then never again", () => {
  const c = newConversation()
  c.olderCells = "old cells"
  c.takeover = "taking over"
  expect(onceNotes(c)).toEqual(["old cells", "taking over"])
  expect(onceNotes(c)).toEqual([])
})
