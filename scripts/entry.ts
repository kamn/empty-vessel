// The compiled empty-vessel's entry (scripts/build.ts). The kernel needs its own files on disk: cells are TypeScript files
// that import Effect, empty-vessel's built-ins and the kernel's runtime, run in Workers and are type-checked by tsc. They
// come packed in the executable as a kit, unpacked once per build to ~/.empty-vessel/runtime/<build> (EMPTY_VESSEL_HOME's), and
// the kernel is pointed at them (globalThis.__emptyVesselKit) before empty-vessel's modules load.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import kit from "../build/kit.tar.gz" with { type: "file" }

// The tools' MCP relay: an agent CLI (Claude Code) starts it as `empty-vessel --relay <socket>` (src/system-two/relay.ts).
if (process.argv[2] === "--relay") {
  await import("../src/system-two/relay-server.ts")
} else {
  const bytes = new Uint8Array(await Bun.file(kit).arrayBuffer())
  const dir = join(process.env.EMPTY_VESSEL_HOME || join(homedir(), ".empty-vessel"), "runtime", Bun.hash(bytes).toString(36))

  // Unpacked into a folder beside it, then renamed into place: a run stopped halfway never leaves a broken kit.
  if (!existsSync(join(dir, "complete"))) {
    const temp = `${dir}.${process.pid}`
    rmSync(temp, { recursive: true, force: true })
    mkdirSync(temp, { recursive: true })
    writeFileSync(join(temp, "kit.tar.gz"), bytes)
    const tar = Bun.spawnSync(["tar", "-xzf", "kit.tar.gz"], { cwd: temp, stderr: "pipe" })
    if (tar.exitCode !== 0) throw new Error(`empty-vessel couldn't unpack its kernel files into ${temp}: ${tar.stderr.toString()}`)
    rmSync(join(temp, "kit.tar.gz"))
    writeFileSync(join(temp, "complete"), "")
    rmSync(dir, { recursive: true, force: true })
    renameSync(temp, dir)
  }

  ;(globalThis as { __emptyVesselKit?: string }).__emptyVesselKit = dir
  await import("../src/main.ts")
}
