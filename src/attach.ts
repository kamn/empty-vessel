import { Effect } from "effect"
import { createConnection } from "node:net"
import { join } from "node:path"
import { createInterface } from "node:readline"

// `empty-vessel --attach`: watch and steer a session the always-on agent (empty-vessel-agent) owns, over its socket,
// instead of running the turn here. A plain line client: what the agent says is printed as lines, what you type is sent.
// ponytail: line mode, not the full TUI; a TUI front end can reuse `shown` and `request`.

// The agent listens on <store>/agent.sock (its store: --agent-store, EMPTY_VESSEL_AGENT_STORE, or ./.sessions).
export const agentSocket = (store: string) => join(store, "agent.sock")

type Said = { readonly type: string; readonly [field: string]: any }
const lines = (text: unknown) => String(text ?? "").split("\n")

// One message from the agent, as the lines to print.
export const shown = (m: Said): Array<string> => {
  if (m.type === "attached") {
    const said = (m.transcript ?? []).flatMap((e: Said) => e.role === "assistant" ? lines(e.text) : [`> ${e.text}${e.role === "steer" ? " (steering)" : ""}`])
    const live = m.live?.running ? [`(in progress: ${m.live.input})`, ...m.live.events.map((e: Said) => `${"  ".repeat(e.depth)}${e.text}`)] : []
    return [`attached to session ${m.sessionId} (${m.name})`, ...said, ...live]
  }

  if (m.type === "event") return m.kind === "activity" ? [] : [`${"  ".repeat(m.depth)}${m.text}`]
  if (m.type === "question") return [`question: ${m.question}`, ...m.options.map((o: string) => `  ${o}`), "answer with /answer <text>"]
  if (m.type === "steer") return [`> ${m.text} (steering)`]
  if (m.type === "submitted") return [`run ${m.runId} queued`]
  if (m.type === "stopping") return [`stopping run ${m.runId}`]
  if (m.type === "parked") return [`run ${m.runId} parked: it restarted 5 times without progress. /retry to start it again.`]
  if (m.type === "sessions") return m.sessions.map((s: Said) => `${s.id === m.selected ? "* " : "  "}${s.id} ${s.name}`)
  if (m.type === "error") return [`error: ${m.message}`]

  if (m.type === "run") {
    if (m.run.status === "succeeded") return lines(m.run.output)
    return [`run ${m.run.id} ${m.run.status}${m.run.error ? `: ${m.run.error}` : ""}`]
  }

  return []
}

// What a typed line asks the agent for. Plain text is a steer: it reaches the running turn, or starts one if none is.
// /new starts an agent session working in `cwd`: Telegram's /sessions lists it too.
export const request = (line: string, cwd = process.cwd()): Said | "quit" | undefined => {
  const text = line.trim()
  const [command, ...rest] = text.split(/\s+/)
  const arg = rest.join(" ")
  const run = arg ? { runId: arg } : {}

  if (!text) return undefined
  if (command === "/quit") return "quit"
  if (command === "/stop") return { type: "stop", ...run }
  if (command === "/retry") return { type: "retry", ...run }
  if (command === "/answer") return { type: "answer", text: arg }
  if (command === "/sessions") return { type: "sessions" }
  if (command === "/use") return { type: "use", sessionId: arg }
  if (command === "/new") return { type: "new", name: arg, cwd }
  return { type: "steer", text, requestId: crypto.randomUUID() }
}

// Attach to `sessionId` (the agent's selected session if undefined) until the input ends, /quit, or the agent goes away.
export const attach = (socket: string, sessionId: string | undefined, input: NodeJS.ReadableStream, print: (line: string) => void, cwd = process.cwd()) =>
  Effect.callback<void, Error>((resume) => {
    const connection = createConnection(socket)
    const typed = createInterface({ input })
    const send = (m: Said) => connection.write(JSON.stringify(m) + "\n")
    let buffer = ""

    connection.setEncoding("utf8")
    connection.on("connect", () => send({ type: "attach", ...(sessionId ? { sessionId } : {}) }))
    connection.on("data", (chunk: string) => {
      buffer += chunk

      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const raw = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        try { for (const line of shown(JSON.parse(raw))) print(line) } catch {}
      }
    })
    connection.on("error", (e) => resume(Effect.fail(new Error(`can't reach the agent at ${socket}: ${e.message}`))))
    connection.on("close", () => { typed.close(); resume(Effect.void) })

    typed.on("line", (line) => {
      const asked = request(line, cwd)
      if (asked === "quit") connection.end()
      else if (asked) send(asked)
    })
    typed.on("close", () => connection.end())

    return Effect.sync(() => { typed.close(); connection.destroy() })
  })
