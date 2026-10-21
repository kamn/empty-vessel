import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { withLock } from "../../src/base/files"

test("withLock removes its own lock afterwards, but never a lock someone else holds by then", async () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-lock-"))
  const path = join(dir, "memory.md"), lock = `${path}.lock`

  await Effect.runPromise(withLock(path, Effect.sync(() => { expect(existsSync(lock)).toBe(true) })))
  expect(existsSync(lock)).toBe(false)

  // While held, another process takes the lock (as one that judged it stale would): releasing leaves theirs.
  await Effect.runPromise(withLock(path, Effect.sync(() => { writeFileSync(lock, "someone else") })))
  expect(readFileSync(lock, "utf8")).toBe("someone else")
})
