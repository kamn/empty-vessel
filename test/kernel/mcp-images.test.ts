import { expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { Effect } from "effect"
import { plainResult, savedImages } from "../../src/kernel/mcp"
import { type Model, systemTwoFromModel } from "../../src/system-two/loop"
import { SystemTwo } from "../../src/system-two/systemtwo"
import { flush, newWire, receive, send, type Wire } from "../../src/system-two/wire"

// An MCP tool's image (a screenshot) reaches the model: saved to a temp file by plainResult, then sent as an image to
// Codex/OpenAI (a user item after the tool result) and to Claude (an image block in the relayed tool result).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const RELAY = new URL("../../src/system-two/relay-server.ts", import.meta.url).pathname
const screenshot = () => String(plainResult({ content: [{ type: "text", text: "the desktop" }, { type: "image", mimeType: "image/png", data: PNG }] }))

test("savedImages finds plainResult's saved images, only real files of its own naming", () => {
  const text = screenshot()
  const [path] = savedImages(text)

  expect(path).toMatch(/empty-vessel-mcp-[0-9a-f-]+\.png$/)
  expect(savedImages(JSON.stringify(text))).toEqual([path!]) // inside a cell's JSON summary too
  expect(savedImages("[image image/png saved: /etc/passwd]")).toEqual([])
  expect(savedImages("[image image/png saved: /tmp/empty-vessel-mcp-00000000-0000-0000-0000-000000000000.png]")).toEqual([])
})

test("Codex/OpenAI: the next round's thread has the image, in a user item after the tool result", async () => {
  const text = screenshot()
  const threads: Array<ReadonlyArray<any>> = []
  const usage = { input: 1, cached: 0, output: 1, thinking: 0 }
  const model: Model = {
    name: "fake",
    complete: (r) => Effect.sync(() => {
      threads.push([...r.thread])
      return threads.length === 1
        ? { text: "", calls: [{ id: "c1", name: "kernel", arguments: JSON.stringify({ code: "x" }) }], keep: [], thinking: "", searches: [], usage }
        : { text: "I see it.", calls: [], keep: [], thinking: "", searches: [], usage }
    }),
  }

  await Effect.runPromise(SystemTwo.use((s) => s.ask("look at the screen", { kernel: () => Effect.succeed(`cell 1: ok\n$1 (string) = ${JSON.stringify(text)}`) })).pipe(Effect.provide(systemTwoFromModel(model, 5))))

  const second = threads[1]!
  const output = second.findIndex((i) => i.type === "function_call_output")
  const after = second[output + 1]
  expect(after.role).toBe("user")
  expect(after.content.find((p: any) => p.type === "input_image").image_url).toStartWith("data:image/png;base64,")
}, 30_000)

test("Claude: the relayed tool result carries an image block beside the text", async () => {
  const text = screenshot()
  const path = `/tmp/empty-vessel-test-img-${process.pid}.sock`
  const server = Bun.listen<Wire>({
    unix: path,
    socket: {
      open: (s) => { s.data = newWire() },
      data: (s, chunk) => { for (const { id } of receive(s, chunk)) send(s, { id, text }) },
      drain: flush,
    },
  })

  const proc = Bun.spawn([process.execPath, RELAY, "--relay", path], { stdin: "pipe", stdout: "pipe" })
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kernel", arguments: { code: "x" } } }) + "\n")
  proc.stdin.flush()

  let out = ""
  for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
    out += chunk
    if (out.includes("\n")) break
  }
  proc.kill()
  server.stop(true)
  rmSync(path, { force: true })

  const content = JSON.parse(out).result.content
  expect(content[0]).toEqual({ type: "text", text })
  expect(content[1]).toMatchObject({ type: "image", mimeType: "image/png" })
  expect(content[1].data.length).toBeGreaterThan(0)
}, 30_000)
