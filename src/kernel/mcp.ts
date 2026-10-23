import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { SourceTool, ToolSource } from "./kernel"

// A tool source backed by an MCP server: the kernel sees a list of tools and a call; the
// protocol stays in here. Only three messages: initialize, tools/list, tools/call. Two ways to reach a server:
// remote (streamable HTTP: a URL, headers such as a login token) or local (stdio: a command, one JSON message per line).
// The connection is made the first time a tool is used, and kept; the tool list is fetched once.

const PROTOCOL = "2025-06-18"
const HELLO = { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "empty-vessel", version: "1" } }

type Json = Record<string, any>
// A request to the server and its reply's `result` (a JSON-RPC error becomes an Error).
type Send = (method: string, params: Json, signal?: AbortSignal) => Promise<any>

// One content block as text: text as it is; an embedded resource's text (its uri first); a resource link's uri; an image
// or audio saved to a temp file, its path given (a cell can read, attach or send it); anything else a short note.
const EXTENSIONS: Readonly<Record<string, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "audio/wav": "wav", "audio/mpeg": "mp3" }
const blockText = (b: Json, dir: string) => {
  if (b.type === "text") return b.text
  if (b.type === "resource" && typeof b.resource?.text === "string") return `[resource ${b.resource.uri ?? ""}]\n${b.resource.text}`
  if (b.type === "resource_link") return `[resource link ${b.uri}${b.name ? ` (${b.name})` : ""}]`
  if ((b.type === "image" || b.type === "audio") && typeof b.data === "string") {
    const path = join(dir, `empty-vessel-mcp-${crypto.randomUUID()}.${EXTENSIONS[b.mimeType] ?? "bin"}`)
    writeFileSync(path, Buffer.from(b.data, "base64"))
    return `[${b.type} ${b.mimeType ?? ""} saved: ${path}]`
  }
  return `[${b.type}${b.mimeType ? ` ${b.mimeType}` : ""} not shown]`
}

// An MCP tool result as a plain value: structured content if given, else the blocks as text (see blockText), parsed as
// JSON when they are JSON. An error result (isError) fails.
export const plainResult = (result: Json, dir = tmpdir()) => {
  const blocks: Array<Json> = result.content ?? []
  const text = blocks.map((b) => blockText(b, dir)).join("\n")
  if (result.isError) throw new Error(text || "the tool reported an error")
  if (result.structuredContent !== undefined) return result.structuredContent
  try { return JSON.parse(text) } catch { return text }
}

// The source, from a way to send requests. `open` runs the handshake before the first request (and again if the server
// forgets the session). `instructions`: what the server said about using it, in its reply to initialize.
const sourceFrom = (name: string, send: Send, reset: () => void, instructions: () => string | undefined): ToolSource & { readonly tools: () => Promise<ReadonlyArray<SourceTool>> } => {
  let listed: Promise<ReadonlyArray<SourceTool>> | undefined
  const tools = () => (listed ??= (async () => {
    const all: Array<SourceTool> = []
    for (let cursor: string | undefined, first = true; first || cursor; first = false) {
      const page = await send("tools/list", cursor ? { cursor } : {})
      for (const t of page.tools ?? []) all.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema, ...(t.annotations?.readOnlyHint === true ? { readOnlyHint: true } : {}) })
      cursor = page.nextCursor
    }
    return all
  })().catch((e) => { listed = undefined; reset(); throw e }))

  return {
    name,
    tools,
    list: Effect.tryPromise({ try: tools, catch: (e) => (e instanceof Error ? e : new Error(String(e))) }),
    instructions,
    // Interrupting the call (the cell stopped) aborts the request.
    call: (tool, args) => Effect.tryPromise({
      try: async (signal) => plainResult(await send("tools/call", { name: tool, arguments: args ?? {} }, signal)),
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    }),
  }
}

// Remote: streamable HTTP. `headers` are asked for on every request (a login token that may have been refreshed);
// after a 401, `unauthorized` (a login's refresh) is called once and the request tried again.
export type RemoteOptions = {
  readonly name: string
  readonly url: string
  readonly headers?: () => Promise<Record<string, string>>
  readonly unauthorized?: () => Promise<void>
}

export const remoteSource = (o: RemoteOptions) => {
  let session: string | undefined, opened: Promise<void> | undefined, next = 0, told: string | undefined

  const post = async (body: Json, signal?: AbortSignal) => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL, ...(session ? { "mcp-session-id": session } : {}), ...(await o.headers?.()) }
    return fetch(o.url, { method: "POST", headers, body: JSON.stringify(body), signal })
  }

  // One request and its reply. The reply is JSON, or an event stream whose data lines hold it.
  // `retried`: a 401 was answered by logging in again; `renewed`: a 404 by a new session. Each once, so a server that
  // keeps refusing fails instead of being asked forever.
  const request = async (method: string, params: Json, signal?: AbortSignal, retried = false, renewed = false): Promise<any> => {
    const id = ++next
    const res = await post({ jsonrpc: "2.0", id, method, params }, signal)
    if (res.status === 401 && !retried && o.unauthorized) { await o.unauthorized(); return request(method, params, signal, true, renewed) }
    if (res.status === 401 || res.status === 403) throw new Error(`${o.name}: not authorized (HTTP ${res.status}); log in again`)
    if (res.status === 404 && session && method !== "initialize" && !renewed) { session = undefined; opened = undefined; await open(); return request(method, params, signal, retried, true) } // the server forgot the session
    if (!res.ok) throw new Error(`${o.name}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)

    session = res.headers.get("mcp-session-id") ?? session
    const text = await res.text()
    const messages = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)) } catch { return undefined } })
      : [JSON.parse(text)]
    const reply = messages.find((m) => m && m.id === id)
    if (!reply) throw new Error(`${o.name}: no reply to ${method}`)
    if (reply.error) throw new Error(`${o.name}: ${reply.error.message ?? JSON.stringify(reply.error)}`)
    return reply.result
  }

  const open = () => (opened ??= (async () => {
    told = (await request("initialize", HELLO))?.instructions
    await post({ jsonrpc: "2.0", method: "notifications/initialized" })
  })().catch((e) => { opened = undefined; throw e }))

  return sourceFrom(o.name, async (method, params, signal) => { await open(); return request(method, params, signal) }, () => { session = undefined; opened = undefined }, () => told)
}

// Local: stdio. The server is started the first time it's needed and stopped with `close`.
const MAX_LINE = 64 * 1024 * 1024 // characters
export type LocalOptions = { readonly name: string; readonly command: string; readonly args?: ReadonlyArray<string>; readonly env?: Readonly<Record<string, string>> }

export const localSource = (o: LocalOptions) => {
  let proc: ReturnType<typeof Bun.spawn> | undefined, opened: Promise<void> | undefined, next = 0, told: string | undefined
  const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

  const start = () => {
    const p = Bun.spawn([o.command, ...(o.args ?? [])], { env: { ...process.env, ...o.env }, stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    ;(async () => {
      // One decoder for the whole stream: a character split between two chunks stays one character. A line longer
      // than MAX_LINE (a server that never ends one) stops the server rather than growing without end.
      let buffer = ""
      const decoder = new TextDecoder()
      for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        if (buffer.length > MAX_LINE) { p.kill(); break }
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          let m: Json
          try { m = JSON.parse(line) } catch { continue }
          const w = m.id !== undefined ? waiting.get(m.id) : undefined
          if (!w) continue
          waiting.delete(m.id)
          if (m.error) w.reject(new Error(`${o.name}: ${m.error.message ?? JSON.stringify(m.error)}`)); else w.resolve(m.result)
        }
      }
      for (const w of waiting.values()) w.reject(new Error(`${o.name}: the server stopped`))
      waiting.clear()
      proc = undefined; opened = undefined
    })()
    return p
  }

  const write = (m: Json) => { proc ??= start(); (proc.stdin as import("bun").FileSink).write(`${JSON.stringify(m)}\n`) }
  const request = (method: string, params: Json, signal?: AbortSignal) => new Promise<any>((resolve, reject) => {
    const id = ++next
    waiting.set(id, { resolve, reject })
    signal?.addEventListener("abort", () => { waiting.delete(id); write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }); reject(new Error("cancelled")) })
    write({ jsonrpc: "2.0", id, method, params })
  })
  const open = () => (opened ??= (async () => {
    told = (await request("initialize", HELLO))?.instructions
    write({ jsonrpc: "2.0", method: "notifications/initialized" })
  })().catch((e) => { opened = undefined; throw e }))

  const source = sourceFrom(o.name, async (method, params, signal) => { await open(); return request(method, params, signal) }, () => { opened = undefined }, () => told)
  return { ...source, close: () => { proc?.kill(); proc = undefined; opened = undefined } }
}
