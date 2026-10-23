import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { agentSocket, attach, request, shown } from "../../src/attach"

// A fake agent on a Unix socket: records what the client sends, answers attach with a transcript and live progress.
const fakeAgent = (dir: string) => {
  const got: Array<Record<string, unknown>> = []
  let client: Socket | undefined
  const server = createServer((socket) => {
    client = socket
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const m = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
        got.push(m)
        if (m.type === "attach") socket.write(JSON.stringify({ type: "attached", sessionId: m.sessionId ?? "s1", name: "Telegram",
          transcript: [{ seq: 3, role: "user", text: "build it" }, { seq: 9, role: "assistant", text: "built" }, { seq: 12, role: "user", text: "long job" }],
          live: { running: true, input: "long job", events: [{ kind: "step", depth: 0, text: "running tests" }] } }) + "\n")
        if (m.type === "steer") socket.write(JSON.stringify({ type: "steer", runId: "r1", text: m.text }) + "\n")
        if (m.type === "stop") socket.write(`${JSON.stringify({ type: "stopping", runId: "r1" })}\n${JSON.stringify({ type: "run", run: { id: "r1", status: "cancelled" } })}\n`)
      }
    })
  })
  return { got, server, client: () => client, listening: new Promise<void>((r) => server.listen(agentSocket(dir), r)) }
}

test("attach shows the transcript and live progress, sends steering and stop, and ends when the agent goes away", async () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-"))
  const agent = fakeAgent(dir)
  const input = new PassThrough(), printed: Array<string> = []
  const until = async (line: string) => { for (let i = 0; i < 200 && !printed.includes(line); i++) await Bun.sleep(10) }
  try {
    await agent.listening
    const done = Effect.runPromise(attach(agentSocket(dir), "s1", input, (line) => printed.push(line)))
    await until("running tests")
    input.write("go faster\n")
    await until("> go faster (steering)")
    input.write("/stop\n")
    await until("run r1 cancelled")
    agent.client()!.end()
    await done

    expect(printed).toEqual(["attached to session s1 (Telegram)", "> build it", "built", "> long job", "(in progress: long job)", "running tests",
      "> go faster (steering)", "stopping run r1", "run r1 cancelled"])
    expect(agent.got.map((m) => m.type)).toEqual(["attach", "steer", "stop"])
    expect(agent.got[0]).toEqual({ type: "attach", sessionId: "s1" })
    expect(agent.got[1]).toMatchObject({ type: "steer", text: "go faster" })
  } finally { agent.server.close(); rmSync(dir, { recursive: true, force: true }) }
})

test("no agent listening: attach fails with where it looked", async () => {
  const exit = await Effect.runPromiseExit(attach("/nonexistent/agent.sock", undefined, new PassThrough(), () => {}))
  expect(Exit.isFailure(exit) && String(exit.cause)).toContain("can't reach the agent at /nonexistent/agent.sock")
})

test("typed lines become agent requests; plain text steers (the agent starts a run if none is going)", () => {
  expect(request("  ")).toBeUndefined()
  expect(request("/quit")).toBe("quit")
  expect(request("/stop")).toEqual({ type: "stop" })
  expect(request("/retry r9")).toEqual({ type: "retry", runId: "r9" })
  expect(request("/answer yes please")).toEqual({ type: "answer", text: "yes please" })
  expect(request("/use s2")).toEqual({ type: "use", sessionId: "s2" })
  expect(request("/new my work", "/tmp/project")).toEqual({ type: "new", name: "my work", cwd: "/tmp/project" })
  expect(request("fix the bug")).toMatchObject({ type: "steer", text: "fix the bug", requestId: expect.any(String) })
  expect(shown({ type: "event", kind: "activity", depth: 0, text: "thinking" })).toEqual([])
  expect(shown({ type: "event", kind: "step", depth: 1, text: "child step" })).toEqual(["  child step"])
  expect(shown({ type: "run", run: { id: "r", status: "succeeded", output: "a\nb" } })).toEqual(["a", "b"])
  expect(shown({ type: "sessions", selected: "b", sessions: [{ id: "a", name: "A" }, { id: "b", name: "B" }] })).toEqual(["  a A", "* b B"])
})
