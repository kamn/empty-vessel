import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeKernel } from "../../src/kernel/kernel"
import { localSource, plainResult, remoteSource } from "../../src/kernel/mcp"
import { sourcesLine, useSources } from "../../src/loop/sources"

const TOOLS = [
  { name: "insights-query", description: "Run an insight query", inputSchema: { type: "object" } },
  { name: "boom", description: "Always fails", inputSchema: { type: "object" } },
]
// What the fake server's tools do.
const callTool = (name: string, args: any) =>
  name === "insights-query" ? { content: [{ type: "text", text: JSON.stringify({ rows: [[args.event, 42]] }) }] }
  : { content: [{ type: "text", text: "quota exceeded" }], isError: true }

// A fake remote MCP server: a session id from initialize, a token, the tool list in two pages, tools/call as an event stream.
const fakeRemote = (token: string) => {
  const seen = { sessions: new Set<string>(), unauthorized: 0 }
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      if (req.headers.get("authorization") !== `Bearer ${token}`) { seen.unauthorized++; return new Response("no token", { status: 401 }) }
      const m = await req.json() as any
      if (m.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (m.method === "initialize") return Response.json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake" }, instructions: "Queries use HogQL; say the project first." } }, { headers: { "mcp-session-id": "s-1" } })
      seen.sessions.add(req.headers.get("mcp-session-id") ?? "none")
      if (m.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: m.id, result: m.params?.cursor ? { tools: TOOLS.slice(1) } : { tools: TOOLS.slice(0, 1), nextCursor: "p2" } })
      if (m.method === "tools/call") return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: callTool(m.params.name, m.params.arguments) })}\n\n`, { headers: { "content-type": "text/event-stream" } })
      return Response.json({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such method" } })
    },
  })
  return { server, url: `http://localhost:${server.port}/mcp`, seen }
}

test("a remote MCP server's tools, from a cell: listed in pages, called as plain functions, results as plain values", async () => {
  const { server, url, seen } = fakeRemote("good")
  try {
    const posthog = remoteSource({ name: "posthog", url, headers: async () => ({ authorization: "Bearer good" }) })
    const k = makeKernel({ dir: mkdtempSync(join(tmpdir(), "empty-vessel-mcp-")), sources: [posthog] })
    const r = await Effect.runPromise(k.run(`import { Effect, posthog } from "kernel"\nexport default Effect.gen(function* () { return (yield* posthog.insights_query({ event: "signup" })).rows })`))
    expect(r).toMatchObject({ status: "ok", value: [["signup", 42]] })
    expect([...seen.sessions]).toEqual(["s-1"]) // the session from initialize, sent back on every request

    const failed = await Effect.runPromise(k.run(`import { posthog } from "kernel"\nexport default posthog.boom()`))
    expect(failed.error).toContain("quota exceeded")
  } finally { server.stop(true) }
})

test("a source's own instructions (from initialize) reach System Two's prompt, after the list of tools", async () => {
  const { server, url } = fakeRemote("good")
  try {
    useSources([remoteSource({ name: "posthog", url, headers: async () => ({ authorization: "Bearer good" }) })])
    const line = await Effect.runPromise(sourcesLine)
    expect(line).toContain("posthog (insights_query")
    expect(line).toContain("posthog's instructions (from the source itself):\nQueries use HogQL; say the project first.")
  } finally { useSources([]); server.stop(true) }
})

test("a 401 calls the login's refresh once, then the request is tried again with the new token", async () => {
  const { server, url, seen } = fakeRemote("fresh")
  try {
    let token = "expired", refreshed = 0
    const source = remoteSource({ name: "posthog", url, headers: async () => ({ authorization: `Bearer ${token}` }), unauthorized: async () => { refreshed++; token = "fresh" } })
    expect((await Effect.runPromise(source.list)).map((t) => t.name)).toEqual(["insights-query", "boom"])
    expect(refreshed).toBe(1)
    expect(seen.unauthorized).toBe(1)

    const never = remoteSource({ name: "posthog", url, headers: async () => ({ authorization: "Bearer wrong" }) })
    expect(await Effect.runPromise(never.list.pipe(Effect.flip))).toMatchObject({ message: expect.stringContaining("not authorized") })
  } finally { server.stop(true) }
})

test("a local (stdio) MCP server works the same, and is stopped with close", async () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-mcp-"))
  const script = join(dir, "server.ts")
  writeFileSync(script, `
const tools = ${JSON.stringify(TOOLS)}
let buffer = ""
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk)
  const lines = buffer.split("\\n"); buffer = lines.pop() ?? ""
  for (const line of lines) {
    const m = JSON.parse(line)
    if (m.id === undefined) continue
    const result = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } }
      : m.method === "tools/list" ? { tools }
      : { content: [{ type: "text", text: "pong " + JSON.stringify(m.params.arguments) }] }
    console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }))
  }
}`)
  chmodSync(script, 0o755)
  const local = localSource({ name: "local", command: process.execPath, args: [script] })
  try {
    const k = makeKernel({ dir: join(dir, "kernel"), sources: [local] })
    const r = await Effect.runPromise(k.run(`import { local } from "kernel"\nexport default local.insights_query({ a: 1 })`))
    expect(r).toMatchObject({ status: "ok", value: `pong {"a":1}` })
  } finally { local.close() }
})

test("results: structured content first, else text (JSON when it is), other blocks noted; an error result fails", () => {
  expect(plainResult({ content: [{ type: "text", text: "[1,2]" }] })).toEqual([1, 2])
  expect(plainResult({ content: [{ type: "text", text: "hello" }] })).toBe("hello")
  expect(plainResult({ structuredContent: { a: 1 }, content: [{ type: "text", text: "ignored" }] })).toEqual({ a: 1 })
  expect(plainResult({ content: [{ type: "image", mimeType: "image/png", data: "…" }] })).toBe("[image image/png not shown]")
  expect(() => plainResult({ content: [{ type: "text", text: "nope" }], isError: true })).toThrow("nope")
})

test("when a cell stops (here: its time limit), its MCP request in flight is aborted", async () => {
  let aborted = false
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const m = await req.json() as any
      if (m.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (m.method === "initialize") return Response.json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {} } })
      if (m.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "slow", description: "never answers" }] } })
      return new Promise<Response>((resolve) => req.signal.addEventListener("abort", () => { aborted = true; resolve(new Response(null, { status: 499 })) }))
    },
  })
  try {
    const k = makeKernel({ dir: mkdtempSync(join(tmpdir(), "empty-vessel-mcp-")), sources: [remoteSource({ name: "svc", url: `http://localhost:${server.port}/mcp` })], timeoutMs: 800 })
    const r = await Effect.runPromise(k.run(`import { svc } from "kernel"\nexport default svc.slow()`))
    expect(r.status).toBe("timeout")
    await Bun.sleep(200)
    expect(aborted).toBe(true)
  } finally { server.stop(true) }
})
