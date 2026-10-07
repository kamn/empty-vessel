import { expect, test } from "bun:test"
import { signalsOf } from "../../src/loop/signals"

// One synthetic session with every kind of signal, minute by minute.
const MIN = 60_000
const cell = (ts: number, code: string, output = "cell 1: ok\n$1 (string) = \"exit 0\"") => ({ role: "command", text: "kernel", args: { code }, output, ts })
const lines = [
  { role: "project", text: "/p", ts: 0 },
  { role: "user", text: "fix the release", ts: 0 },
  cell(1 * MIN, `export default bash("bun run release:test", 30)`, "cell 1: ok\n$1 (string) = \"exit 137 (timed out after 30s and was stopped…)\""),
  cell(2 * MIN, `export default bash("bun run release:test", 30)`), // the same cell again
  cell(3 * MIN, `export default readText("wrangler.jsonc")`),
  cell(4 * MIN, `export default readText("wrangler.jsonc")`),
  { role: "flag", text: "it's rereading again", running: true, activity: "running", ts: 4.5 * MIN },
  cell(5 * MIN, `export default readText("wrangler.jsonc")`),
  { role: "command", text: "tell_user", args: { message: "found it" }, ts: 11 * MIN }, // 11 minutes after the start: a silence
  cell(12 * MIN, `export default bash("bun test")`, "cell 2: ok\n$2 (string) = \"exit 1\""),
  cell(13 * MIN, `export default bash("PATH=$HOME/.nvm/versions/node/v24/bin:$PATH bun test")`),
  { role: "check", text: "bun test", verdict: "failed", ts: 14 * MIN },
  { role: "check", text: "bun test", verdict: "failed", ts: 15 * MIN },
  { role: "scope", text: "your changes now reach packages/landing", ts: 16 * MIN },
  { role: "steer", text: "only touch collab", ts: 17 * MIN },
  { role: "actions", text: "stopped by the user", ts: 18 * MIN },
  { role: "assistant", text: "(stopped)", ts: 18 * MIN },
]

test("refine's signals: silence, timeout and its rerun, rereads, failing checks, scope, steering, a stop, a long turn; flags with what came before; a fix that took an env var", () => {
  const { signals, flags, fixes } = signalsOf("01abc-session", lines as never)
  expect(signals.map((s) => s.kind)).toEqual(["timeout", "rerun", "reread", "silence", "checks", "scope", "steer", "stop", "silence", "long"])
  expect(signals.find((s) => s.kind === "reread")?.text).toBe("read wrangler.jsonc 3 times without changing it")
  expect(signals.find((s) => s.kind === "silence")?.text).toBe("11 min without telling the user anything")

  expect(flags).toHaveLength(1)
  expect(flags[0]).toMatchObject({ turn: 1, note: "it's rereading again", running: true })
  expect(flags[0]!.before.at(-1)).toContain(`readText("wrangler.jsonc")`)

  expect(fixes).toHaveLength(1)
  expect(fixes[0]).toContain("then worked with PATH=$HOME/.nvm/versions/node/v24/bin:$PATH")
})
