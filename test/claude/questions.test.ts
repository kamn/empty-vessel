import { expect, test } from "bun:test"
import { randomUUIDv7 } from "bun"
import { rmSync } from "node:fs"
import { Effect } from "effect"
import { newRun, serve } from "../../src/system-two/relay"
import type { AskUserArgs } from "../../src/system-two/systemtwo"

const MCP = new URL("../../src/system-two/relay-server.ts", import.meta.url).pathname

// Real MCP subprocess, real socket and Claude handler; only the human and kernel are stand-ins.
test("Claude MCP advertises questions, relays answers, rejects bad input, and keeps the run open", () =>
  Effect.runPromise(Effect.acquireUseRelease(
    Effect.sync(() => {
      const path = `/tmp/dq-${randomUUIDv7().slice(-12)}.sock`
      const run = newRun()
      const seen: Array<typeof AskUserArgs.Type> = []
      const hooks = {
        askUser: (args: typeof AskUserArgs.Type) => Effect.sync(() => {
          seen.push(args)
          return JSON.stringify(args.questions.map(({ question }, i) => ({ question, answer: i === 0 ? "No" : "My own answer" })))
        }),
        kernel: () => Effect.succeed("continued after the answer"),
      }
      const server = serve(path, hooks, run)

      try {
        const proc = Bun.spawn([process.execPath, MCP, "--relay", path], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })
        const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader()
        return { path, run, seen, server, proc, reader }
      } catch (error) {
        server.stop(true)
        rmSync(path, { force: true })
        throw error
      }
    }),
    ({ run, seen, proc, reader }) => Effect.gen(function* () {
      let buffered = ""
      let next = 0
      const request = (method: string, params?: object) => Effect.gen(function* () {
        const id = ++next
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
        yield* Effect.promise(() => Promise.resolve(proc.stdin.flush()))

        while (!buffered.includes("\n")) {
          const chunk = yield* Effect.promise(() => reader.read())
          if (chunk.done) throw new Error("MCP closed before replying")
          buffered += chunk.value
        }

        const end = buffered.indexOf("\n")
        const reply = JSON.parse(buffered.slice(0, end))
        buffered = buffered.slice(end + 1)
        expect(reply.id).toBe(id)
        expect(reply.error).toBeUndefined()
        return reply.result
      })
      const call = (name: string, args: object) => request("tools/call", { name, arguments: args })

      const initialized = yield* request("initialize")
      expect(initialized.capabilities.tools).toEqual({})
      const listed = yield* request("tools/list")
      const tool = listed.tools.find((t: { name: string }) => t.name === "ask_user")
      expect(tool.description).toContain("interactive questions")
      expect(tool.inputSchema.properties.questions.minItems).toBe(1)

      const args = { questions: [{ question: "Deploy?", options: ["Yes", "No"] }, { question: "Approach?", options: ["Default"] }] }
      const result = yield* call("ask_user", args)
      expect(seen).toEqual([args])
      expect(JSON.parse(result.content[0].text)).toEqual([
        { question: "Deploy?", answer: "No" },
        { question: "Approach?", answer: "My own answer" },
      ])
      expect(run.ended).toBeUndefined()

      const invalid = yield* call("ask_user", { questions: [] })
      expect(invalid.content[0].text).toStartWith("invalid arguments")
      expect(seen).toHaveLength(1)
      const continued = yield* call("kernel", { code: "export default 1" })
      expect(continued.content[0].text).toBe("continued after the answer")
      expect(run.ended).toBeUndefined()
    }).pipe(Effect.timeout("4 seconds")),
    ({ path, server, proc, reader }) => Effect.gen(function* () {
      proc.kill()
      yield* Effect.promise(() => reader.cancel())
      yield* Effect.promise(() => proc.exited)
      server.stop(true)
      rmSync(path, { force: true })
    }),
  )),
)
