import { randomUUIDv7 } from "bun"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { raw } from "../kernel/guard"
import { Effect } from "effect"

// Output limits, the same as Pi's: keep the LAST 2000 lines or 50KB, whichever comes first
// (errors and test summaries are at the end), and save the full output to a temp file.
export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024

// The tail of `text` that fits the limits, plus a note saying which lines are shown and where the rest is.
export const truncateTail = (text: string) => {
  const lines = text.split("\n")
  let start = lines.length
  let bytes = 0
  while (start > 0 && lines.length - start < MAX_LINES) {
    const size = Buffer.byteLength(lines[start - 1] ?? "") + 1
    if (bytes + size > MAX_BYTES) break
    bytes += size
    start--
  }

  if (start === 0) return text

  const path = join(tmpdir(), `empty-vessel-bash-${randomUUIDv7()}.txt`)
  writeFileSync(path, text)
  // One huge last line doesn't fit whole: show its end. (ponytail: slices characters, not bytes; fine for ASCII output)
  const shown = start === lines.length ? (lines.at(-1) ?? "").slice(-MAX_BYTES) : lines.slice(start).join("\n")
  const range = start === lines.length ? `the end of line ${lines.length}` : `lines ${start + 1}-${lines.length}`
  return `${shown}\n\n[Showing ${range} of ${lines.length}. Full output: ${path}]`
}

// Run a shell command in the folder empty-vessel was started in. YOLO: no confirmation (isolation comes from containers).
// Returns the exit code plus stdout and stderr as text, killed after `timeoutMs`, trimmed to the limits above,
// so one huge or endless command can't flood the LLM's context or hang the turn.
// ponytail: Bun.spawn inside a promise; Effect's ChildProcess module is the upgrade if we need streaming or cancellation.
// A command's time limit unless it says otherwise: long enough for a repo's tests or build (30 s cut real runs short, and
// the model reran the same batch, which timed out again).
export const BASH_TIMEOUT_SECONDS = 120

export const runBash = (command: string, timeoutMs = BASH_TIMEOUT_SECONDS * 1000) =>
  // The command runs in its own process group, so a stop (Ctrl+C aborts `signal`) or the timeout kills everything it
  // started: killing only `bash` would leave its children (e.g. a `sleep`) running.
  Effect.tryPromise(async (signal) => {
    const proc = raw.spawn(["bash", "-c", command], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", detached: true })
    const killGroup = () => { try { process.kill(-proc.pid, "SIGKILL") } catch {} } // already gone: nothing to do
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killGroup() }, timeoutMs)
    signal.addEventListener("abort", killGroup)

    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    clearTimeout(timer)
    signal.removeEventListener("abort", killGroup)

    const text = `${out}${err}`.trim() || "(no output)"
    // A timeout says what to do next: rerunning the same command only times out again.
    const limit = timeoutMs / 1000
    const stopped = ` (timed out after ${limit}s and was stopped: what it printed until then is below. To let it run longer, give it a longer timeout, e.g. bash(command, ${limit * 4}) in a cell; or split it into shorter commands)`
    return `exit ${code}${timedOut ? stopped : ""}\n${truncateTail(text)}`
  }).pipe(Effect.orElseSucceed(() => `could not run: ${command}`))
