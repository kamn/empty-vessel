import { expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { newWire, receive, send, flush, type Wire } from "../../src/system-two/wire"

const MCP = new URL("../../src/system-two/relay-server.ts", import.meta.url).pathname

// A long answer (bigger than one socket write, with multi-byte characters that can split across chunks) comes back
// whole through the MCP server, as empty-vessel's side sends it (src/plugins/claude/claude.ts).
test("the relay carries a long answer whole", async () => {
  const path = `/tmp/empty-vessel-test-${process.pid}.sock`
  const long = "é→ ".repeat(70_000)
  const server = Bun.listen<Wire>({
    unix: path,
    socket: {
      open: (s) => { s.data = newWire() },
      data: (s, chunk) => { for (const { id, tool } of receive(s, chunk)) send(s, { id, text: `${tool}:${long}` }) },
      drain: flush,
    },
  })

  const proc = Bun.spawn([process.execPath, MCP, "--relay", path], { stdin: "pipe", stdout: "pipe" })
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "more_output", arguments: { id: "out1" } } }) + "\n")
  proc.stdin.flush()

  let out = ""
  for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
    out += chunk
    if (out.includes("\n")) break
  }
  proc.kill()
  server.stop(true)
  rmSync(path, { force: true })

  expect(JSON.parse(out).result.content[0].text).toBe(`more_output:${long}`)
})
