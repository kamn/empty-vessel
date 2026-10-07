import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeClaudeSystemTwo } from "../../src/plugins/claude/claude"
import { SystemTwo, type Hooks } from "../../src/system-two/systemtwo"

// The fake CLI records actual argv. Its state file simulates a skill activation during a
// provider-managed conversation, before a max-turn retry or a pending-job reminder.
for (const continuation of ["next ask", "max turns", "pending jobs"] as const) {
  test(`Claude durable skill snapshot refreshes on ${continuation}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-skills-"))
    const fake = join(dir, "claude")
    const log = join(dir, "args.jsonl")
    const state = join(dir, "state")
    const catalog = "<skill_catalog>initial: user-only; later: model; dormant: model</skill_catalog>"
    const initial = "<activated_skill name=\"initial\">INITIAL FULL INSTRUCTIONS</activated_skill>"
    const later = "<activated_skill name=\"later\">LATER FULL INSTRUCTIONS</activated_skill>"
    const dormant = "DORMANT FULL INSTRUCTIONS"
    writeFileSync(state, `${catalog}\n${initial}`)
    writeFileSync(fake, `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs"
const first = !existsSync(${JSON.stringify(log)})
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n")
if (process.argv.includes("--input-format")) await Bun.stdin.text()
if (first) writeFileSync(${JSON.stringify(state)}, ${JSON.stringify(`${catalog}\n${initial}\n${later}`)})
console.log(JSON.stringify({ type: "result", subtype: first && ${JSON.stringify(continuation)} === "max turns" ? "error_max_turns" : "success", session_id: "skill-session", result: "ok" }))
`)
    chmodSync(fake, 0o755)
    const previous = process.env.EMPTY_VESSEL_CLAUDE_BIN
    process.env.EMPTY_VESSEL_CLAUDE_BIN = fake
    let snapshots = 0, reminders = 0
    const hooks: Hooks = {
      thread: [],
      briefing: "Existing briefing must survive.",
      skillContext: () => { snapshots++; return readFileSync(state, "utf8") },
      pending: () => continuation === "pending jobs" && reminders++ === 0 ? ["job still running"] : [],
    }
    try {
      await Effect.runPromise(Effect.gen(function* () {
        const provider = yield* SystemTwo
        expect(snapshots).toBe(0) // Not fetched when the provider is constructed.
        yield* provider.ask("start", hooks)
        if (continuation === "next ask") yield* provider.ask("continue", hooks)
      }).pipe(Effect.provide(makeClaudeSystemTwo())))
      const calls: string[][] = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      expect(calls).toHaveLength(2)
      expect(snapshots).toBe(2)
      const prompts = calls.map((args) => args[args.indexOf("--system-prompt") + 1]!)
      for (const prompt of prompts) {
        expect(prompt).toContain("Existing briefing must survive.")
        expect(prompt).toContain(catalog)
        expect(prompt).toContain(initial) // Includes already-activated user-only skills.
        expect(prompt).not.toContain(dormant)
        expect(prompt).toContain("After internal compaction")
        expect(prompt).toContain("activated later than the current system snapshot must be reloaded via kernel skill before continuing its workflow")
        expect(prompt).toContain("Never rely on a compacted summary as its full instructions")
        expect(prompt).toContain("If reload fails, stop and report the failure rather than proceeding")
      }
      expect(prompts[0]).not.toContain(later)
      expect(prompts[1]).toContain(later)
      expect(calls[1]).toContain("--resume")
      expect(calls[1]).toContain("skill-session")
    } finally {
      if (previous === undefined) delete process.env.EMPTY_VESSEL_CLAUDE_BIN
      else process.env.EMPTY_VESSEL_CLAUDE_BIN = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
