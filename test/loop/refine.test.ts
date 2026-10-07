import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// refine reads sessions and writes notes, checks and its log under EMPTY_VESSEL_HOME, which is fixed when empty-vessel's modules
// load: so the case runs in a child with its own home, holding a config with fake systems.
test("refine: flags and signals first, three kinds of proposal kept only with the user's OK, undo, the next refine sees only what's new", async () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-refine-home-"))
  writeFileSync(join(home, "config.json"), JSON.stringify({ systemOne: { use: "fake" }, systemTwo: { use: "fake" } }))
  try {
    const proc = Bun.spawn([process.execPath, "test", "./test/fixtures/refine.case.ts"], { cwd: process.cwd(), env: { ...process.env, EMPTY_VESSEL_HOME: home }, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect(out + err).toContain("1 pass")
    expect(code).toBe(0)
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 60_000)
