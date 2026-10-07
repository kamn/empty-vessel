import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { makeKernel } from "../../src/kernel/kernel"
import { KERNEL_INSTRUCTIONS } from "../../src/system-two/instructions"

const BUILTINS = new URL("../../src/tools/kernel-builtins.ts", import.meta.url).pathname
const TSC = new URL("../../node_modules/.bin/tsc", import.meta.url).pathname

// A stub System One: sure on urgency; on team, sure for ticket 1, "can't tell" for ticket 2 (so only that one is re-checked).
const asked: Array<string> = []
const rechecked: Array<Record<string, unknown>> = []
const host = {
  systemOne: (arg: unknown) => {
    const { evidence } = arg as { evidence: string }
    asked.push(evidence)
    return Effect.succeed({ urgency: { choice: "2", confidence: 0.31 }, team: evidence.includes("password") ? { choice: "login", confidence: 0.9 } : { choice: "unclear", confidence: 0.8 } })
  },
  recheck: (arg: unknown) => {
    rechecked.push(arg as Record<string, unknown>)
    return Effect.succeed({ team: "billing" })
  },
  spawn: (task: unknown) => Effect.succeed(`job-${String(task).includes("billing") ? 1 : 2}`),
  wait: (arg: unknown) => Effect.succeed(Object.fromEntries((arg as { ids: Array<string> }).ids.map((id) => [id, { status: "done", answer: `${id} drafted` }]))),
}

// The example cells in System Two's instructions must work as written: they're what it learns the kernel from.
test("the worked examples in the instructions run under the kernel's rules: judge re-checks only what System One couldn't settle, and is remembered; sub-agents don't block", async () => {
  const cells = [...KERNEL_INSTRUCTIONS.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!)
  expect(cells).toHaveLength(3)

  const project = mkdtempSync(`${tmpdir()}/empty-vessel-project-`)
  writeFileSync(`${project}/tickets.jsonl`, [{ id: "T-1", subject: "Can't log in", body: "password reset fails" }, { id: "T-2", subject: "Charged twice", body: "two charges on my card" }].map((t) => JSON.stringify(t)).join("\n"))
  const k = makeKernel({ dir: mkdtempSync(`${tmpdir()}/empty-vessel-kernel-`), builtins: BUILTINS, tsc: TSC })
  const inProject = (code: string) => code.replaceAll("data/tickets.jsonl", `${project}/tickets.jsonl`).replaceAll("work/triage.jsonl", `${project}/triage.jsonl`)

  const one = await Effect.runPromise(k.run(inProject(cells[0]!), host))
  expect(one).toMatchObject({ status: "ok", defines: ["showTicket", "tickets"], value: { count: 2, first: "Can't log in\npassword reset fails" } })

  const two = await Effect.runPromise(k.run(inProject(cells[1]!), host))
  expect(two).toMatchObject({ status: "ok", value: { judged: 2, byLLM: 1 } })
  expect(asked).toHaveLength(2) // one System One call per ticket, both questions at once
  expect(rechecked).toEqual([{ evidence: "Charged twice\ntwo charges on my card", questions: { team: expect.objectContaining({ question: "Which team should handle it?" }) } }])
  expect(readFileSync(`${project}/triage.jsonl`, "utf8").split("\n").map((l) => JSON.parse(l))).toEqual([
    { id: "T-1", urgency: "2", team: "login" }, // urgency on a 4-level scale stands even at 0.31
    { id: "T-2", urgency: "2", team: "billing" }, // System One couldn't tell: the LLM re-check decided
  ])
  // triage is remembered for these tickets: running the cell again asks System One nothing new.
  expect(await Effect.runPromise(k.run(inProject(cells[1]!), host))).toMatchObject({ status: "ok", value: { judged: 2, byLLM: 1 } })
  expect(asked).toHaveLength(2)

  // Sub-agents without blocking: two started, other work done, then both collected.
  const three = await Effect.runPromise(k.run(inProject(cells[2]!), host))
  expect(three).toMatchObject({ status: "ok", value: { drafts: { "job-1": { status: "done", answer: "job-1 drafted" }, "job-2": { status: "done", answer: "job-2 drafted" } } } })
})
