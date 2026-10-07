// A tiny LSP peer for kernel fail-closed tests. The fallback compiler always fails silently.
import { appendFileSync } from "node:fs"

const [report, fallback, ...args] = process.argv.slice(2)
if (!args.includes("--lsp")) {
  appendFileSync(fallback!, "fallback\n")
  process.exit(7)
}

let buffer = Buffer.alloc(0)
for await (const chunk of Bun.stdin.stream()) {
  buffer = Buffer.concat([buffer, Buffer.from(chunk)])

  for (;;) {
    const head = buffer.indexOf("\r\n\r\n")
    if (head < 0) break
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, head).toString())![1])
    if (buffer.length < head + 4 + length) break
    const message = JSON.parse(buffer.subarray(head + 4, head + 4 + length).toString())
    buffer = buffer.subarray(head + 4 + length)
    if (message.id === undefined) continue

    const result = message.method === "initialize" ? { capabilities: { diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } } } : JSON.parse(report!)
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }))
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
    process.stdout.write(body)
  }
}
