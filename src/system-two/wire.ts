import type { Socket } from "bun"

// JSON lines over a Bun socket, for the relay between empty-vessel and the MCP server an agent CLI starts (src/system-two/relay.ts). Bun's write can
// take only part of a long message (it returns how many bytes it took), so the rest waits here for the drain event;
// and a chunk read can end mid-line (or mid-character), so a partial line waits for the next chunk.

export type Wire = { input: string; output: Uint8Array; decoder: TextDecoder }
export const newWire = (): Wire => ({ input: "", output: new Uint8Array(), decoder: new TextDecoder() })

// Send what's queued; call it from the socket's drain handler too.
export const flush = (s: Socket<Wire>) => {
  const n = s.write(s.data.output)
  s.data.output = s.data.output.subarray(Math.max(n, 0))
}

export const send = (s: Socket<Wire>, message: object) => {
  const bytes = new TextEncoder().encode(JSON.stringify(message) + "\n")
  const queued = new Uint8Array(s.data.output.length + bytes.length)
  queued.set(s.data.output)
  queued.set(bytes, s.data.output.length)
  s.data.output = queued
  flush(s)
}

// The complete messages in what's arrived so far.
export const receive = (s: Socket<Wire>, chunk: Uint8Array) => {
  s.data.input += s.data.decoder.decode(chunk, { stream: true })
  const lines = s.data.input.split("\n")
  s.data.input = lines.pop()!
  return lines.filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>)
}
