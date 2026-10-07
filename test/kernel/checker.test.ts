import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkWithServer, closeChecker } from "../../src/kernel/checker"

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

test("a shared checker is reused, overlapping closes await exit, and later checks restart it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-checker-lifetime-"))
  const tsc = join(dir, "tsc")
  const pids = join(dir, "pids")
  const fallback = join(dir, "fallback")
  const fixture = new URL("./fixtures/fake-tsc.ts", import.meta.url).pathname
  writeFileSync(tsc, `#!/bin/sh\necho $$ >> ${quote(pids)}\nexec ${quote(process.execPath)} ${quote(fixture)} ${quote(JSON.stringify({ kind: "full", items: [] }))} ${quote(fallback)} --slow-exit "$@"\n`)
  chmodSync(tsc, 0o755)
  const processes = () => readFileSync(pids, "utf8").trim().split("\n").map(Number)
  const check = async (project: string) => {
    mkdirSync(project, { recursive: true })
    const cell = join(project, "cell.ts")
    writeFileSync(cell, "export const n = 1")
    expect(await checkWithServer(tsc, project, cell, [])).toBe("")
  }

  try {
    const first = join(dir, "first")
    await check(first)
    await check(join(dir, "second"))
    expect(processes()).toHaveLength(1) // one server, even across temporary projects
    const [pid] = processes()
    expect(() => process.kill(pid!, 0)).not.toThrow()

    const closing = closeChecker(tsc)
    try {
      await closeChecker(tsc) // an overlapping close must also wait for the delayed exit
      expect(() => process.kill(pid!, 0)).toThrow()
    } finally {
      await closing
    }
    await closeChecker(tsc) // idempotent
    rmSync(first, { recursive: true }) // the old server's cwd can now be removed

    await check(join(dir, "third"))
    expect(processes()).toHaveLength(2)
    expect(processes()[1]).not.toBe(pid)
    expect(existsSync(fallback)).toBe(false)
    const restarted = processes()[1]!
    await closeChecker(tsc)
    expect(() => process.kill(restarted, 0)).toThrow()
  } finally {
    await closeChecker(tsc)
    rmSync(dir, { recursive: true, force: true })
  }
}, 15_000)
