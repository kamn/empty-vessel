import { Effect, Stream } from "effect"
import { flush, newWire, receive, send, type Wire } from "./wire"
import { systemTwoTools } from "./dispatch"

// The MCP server an agent CLI starts to reach System Two's tools (src/system-two/relay.ts: serveTools; Claude Code is
// the one today). Stdio, one JSON-RPC message per line. Its tools are the core's (same descriptions, same arguments as
// any backend gets); it runs nothing itself: each call goes to empty-vessel over the socket given as `--relay <socket>`, and
// empty-vessel answers it (a cell runs in its session kernel).

const TOOLS = systemTwoTools(process.env.EMPTY_VESSEL_GRANTS ? JSON.parse(process.env.EMPTY_VESSEL_GRANTS) : undefined).map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }))

// Send a tool call to empty-vessel and wait for its answer. One JSON line each way: { id, tool, args } out, { id, text } back.
const relay = (path: string) => {
  const waiting = new Map<number, (text: string) => void>()
  let next = 0
  const connected = Bun.connect<Wire>({
    unix: path,
    data: newWire(),
    socket: {
      data: (s, chunk) => {
        for (const m of receive(s, chunk) as Array<{ id: number; text: string }>) {
          waiting.get(m.id)?.(m.text)
          waiting.delete(m.id)
        }
      },
      drain: flush,
    },
  })

  return (tool: string, args: object) =>
    Effect.promise(async () => {
      const socket = await connected
      const id = ++next
      const answer = new Promise<string>((resolve) => waiting.set(id, resolve))
      send(socket, { id, tool, args })
      return answer
    })
}

const [flag, socketPath] = process.argv.slice(2)
if (flag !== "--relay" || !socketPath) throw new Error("usage: bun src/system-two/relay-server.ts --relay <socket>")
const call = relay(socketPath)

// One request in, its reply out (undefined for notifications, which get none).
const handle = (m: { id?: number | string; method: string; params?: { name?: string; arguments?: object } }): Effect.Effect<object | undefined> => {
  if (m.id === undefined) return Effect.succeed(undefined)
  if (m.method === "initialize") return Effect.succeed({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "kernel", version: "0.1" } })
  if (m.method === "tools/list") return Effect.succeed({ tools: TOOLS })
  if (m.method === "tools/call") return call(m.params?.name ?? "kernel", m.params?.arguments ?? {}).pipe(Effect.map((text) => ({ content: [{ type: "text", text }] })))
  return Effect.succeed({ error: { code: -32601, message: `no method ${m.method}` } })
}

const reply = (id: number | string, r: object) => console.write(JSON.stringify("error" in r ? { jsonrpc: "2.0", id, ...r } : { jsonrpc: "2.0", id, result: r }) + "\n")

// One message at a time, in order (a long cell holds up the next request). empty-vessel also answers one call at a time,
// since two cells at once would clash in the kernel (src/system-two/relay.ts).
await Effect.runPromise(Stream.fromAsyncIterable(console, String).pipe(Stream.runForEach((line) => {
  if (!line.trim()) return Effect.void
  const m = JSON.parse(line)
  return handle(m).pipe(Effect.map((r) => { if (r) reply(m.id, r) }))
})))
