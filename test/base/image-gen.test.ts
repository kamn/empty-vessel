import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Redacted, Schema } from "effect"
import { ALL } from "../../src/base/grants"
import { ConfigSchema } from "../../src/base/config"
import { makeMedia, type Http } from "../../src/base/media"
import { makeHost } from "../../src/loop/kernel"
import { builtinsModule } from "../../src/loop/library"
import type { Ctx } from "../../src/loop/turnkit"
import { kernelInstructions } from "../../src/system-two/instructions"
import { EFFECTS } from "../../src/tools/kernel-service"
import { telegramMedia } from "../../src/plugins/telegram/media"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "empty-vessel-image-")); roots.push(dir); return dir }
const settings = { ...Schema.decodeUnknownSync(ConfigSchema)({}).media, baseUrl: "https://media.test/v1", apiKeyEnv: "EV_IMAGE_TEST_KEY" }
process.env.EV_IMAGE_TEST_KEY = "sk-test-only"
const recording = (reply: (url: string) => Response) => {
  const calls: { url: string; init: RequestInit }[] = []
  const http: Http = async (url, init) => { calls.push({ url, init }); return reply(url) }
  return { http, calls }
}
const PNG = "PNG fake image"

test("image posts the prompt with the configured model and saves the returned bytes, owner-only", async () => {
  const path = join(temp(), "images", "a.png")
  const mock = recording(() => Response.json({ data: [{ b64_json: Buffer.from(PNG).toString("base64") }] }))

  expect(await Effect.runPromise(makeMedia({ ...settings, imageModel: "img-test" }, mock.http).image("a red fox", path))).toBe(path)
  expect(readFileSync(path, "utf8")).toBe(PNG)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(mock.calls[0]!.url).toBe("https://media.test/v1/images/generations")
  expect(JSON.parse(String(mock.calls[0]!.init.body))).toEqual({ model: "img-test", prompt: "a red fox", n: 1 })
})

test("the default image model is gpt-image-2", () => {
  expect(Schema.decodeUnknownSync(ConfigSchema)({}).media.imageModel).toBe("gpt-image-2")
})

test("a url reply is downloaded at once, without the API key", async () => {
  const path = join(temp(), "b.png")
  const mock = recording((url) => url.endsWith("/generations") ? Response.json({ data: [{ url: "https://files.test/b.png" }] }) : new Response(PNG))

  await Effect.runPromise(makeMedia(settings, mock.http).image("x", path))
  expect(readFileSync(path, "utf8")).toBe(PNG)
  expect(mock.calls[1]!.url).toBe("https://files.test/b.png")
  expect(JSON.stringify(mock.calls[1]!.init.headers ?? {})).not.toContain("sk-test-only")
})

test("a refused request and a reply without an image are clear errors, and nothing is saved", async () => {
  const path = join(temp(), "c.png")
  const run = (reply: () => Response) => Effect.runPromise(Effect.flip(makeMedia(settings, recording(reply).http).image("x", path)))

  expect((await run(() => new Response("{}", { status: 400 }))).message).toContain("(400)")
  expect((await run(() => Response.json({ data: [] }))).message).toContain("no image")
  expect(() => statSync(path)).toThrow()
})

// The host built-in against a local fake API (tests reach only this machine).
const host = (media: object, tools = ALL) => {
  const dir = temp()
  const ctx = { config: { media: { ...settings, ...media }, kernel: { tools } }, session: { dir } } as unknown as Ctx
  return { dir, host: makeHost(ctx, Context.empty() as never) }
}

test("the image built-in saves a file in the session's kernel folder and returns its path", async () => {
  using server = Bun.serve({ port: 0, fetch: () => Response.json({ data: [{ b64_json: Buffer.from(PNG).toString("base64") }] }) })
  const { dir, host: h } = host({ baseUrl: `http://localhost:${server.port}/v1` })

  const path = String(await Effect.runPromise(h.image!("a lighthouse")))
  expect(path.startsWith(join(dir, "kernel", "images"))).toBe(true)
  expect(path.endsWith(".png")).toBe(true)
  expect(readFileSync(path, "utf8")).toBe(PNG)
})

test("an API failure reaches the cell as a clear error; without the media grant nothing is called", async () => {
  using server = Bun.serve({ port: 0, fetch: () => new Response("{}", { status: 500 }) })
  const failing = host({ baseUrl: `http://localhost:${server.port}/v1` }).host
  expect((await Effect.runPromise(Effect.flip(failing.image!("x"))) as Error).message).toContain("refused the request (500)")

  const denied = host({ baseUrl: "https://media.test/v1" }, { ...ALL, media: false }).host
  expect((await Effect.runPromise(Effect.flip(denied.image!("x"))) as Error).message).toContain("media")
})

test("image is an effectful built-in under the media grant, and System Two is told of it only when granted", () => {
  expect(EFFECTS.image).toBe("effectful")
  expect(builtinsModule([], ALL)).toContain("image")
  expect(builtinsModule([], { ...ALL, media: false }).split(" from ")[0]).not.toMatch(/\bimage\b/)
  expect(kernelInstructions(ALL)).toContain("image(prompt)")
  expect(kernelInstructions({ ...ALL, media: false })).not.toContain("image(prompt)")
})

test("Telegram sends a .png with sendPhoto and other files as documents", async () => {
  const dir = temp(), methods: string[] = []
  const http = async (url: string) => { methods.push(url.split("/").at(-1)!); return Response.json({ ok: true, result: { message_id: 1 } }) }
  const media = telegramMedia(Redacted.make("123:fake-test-only"), dir, http)
  writeFileSync(join(dir, "a.png"), PNG)
  writeFileSync(join(dir, "a.txt"), "text")

  await Effect.runPromise(media.send(join(dir, "a.png"), "42"))
  await Effect.runPromise(media.send(join(dir, "a.txt"), "42"))
  expect(methods).toEqual(["sendPhoto", "sendDocument"])
})
