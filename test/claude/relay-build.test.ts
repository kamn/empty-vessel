import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { newWire, receive, send, flush, type Wire } from "../../src/system-two/wire"

// The relay branch starts before the compiled application's runtime kit is unpacked.
// Importing the full kernel from dispatch breaks package resolution only outside the checkout.
test("compiled relay starts outside the repository without a runtime kit", async () => {
  const dir = mkdtempSync("/tmp/ev-relay-build-")
  const binary = join(dir, "relay"), socket = join(dir, "relay.sock")
  let server: ReturnType<typeof Bun.listen<Wire>> | undefined
  let proc: ReturnType<typeof Bun.spawn> | undefined

  try {
    const build = Bun.spawnSync([process.execPath, "build", "--compile", new URL("../../src/system-two/relay-server.ts", import.meta.url).pathname, "--outfile", binary], { stdout: "pipe", stderr: "pipe" })
    expect(build.exitCode, build.stderr.toString()).toBe(0)
    server = Bun.listen<Wire>({ unix: socket, socket: {
      open: s => { s.data = newWire() },
      data: (s, chunk) => { for (const { id, tool } of receive(s, chunk)) send(s, { id, text: `${tool}:ok` }) },
      drain: flush,
    } })
    const child = Bun.spawn([binary, "--relay", socket], { cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    proc = child
    const timer = setTimeout(() => child.kill(), 10_000)

    try {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kernel", arguments: {} } }) + "\n")
      child.stdin.flush()
      let output = ""
      for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
        output += chunk
        if (output.includes("\n")) break
      }
      if (!output.trim()) throw new Error(`relay failed: ${await new Response(child.stderr).text()}`)
      expect(JSON.parse(output.trim()).result.content[0].text).toBe("kernel:ok")
    } finally { clearTimeout(timer) }
  } finally {
    proc?.kill()
    if (proc) await proc.exited
    server?.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
