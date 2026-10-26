import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Redacted } from "effect"
import { makeTelegramChannel } from "../../../src/plugins/telegram"
import { telegramHtml } from "../../../src/plugins/telegram/format"
import type { Http } from "../../../src/plugins/telegram/http"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

test("markdown becomes Telegram's HTML subset, every text escaped", () => {
  expect(telegramHtml("# Plan <v2>\n\nA & B **bold *it*** `a<b>` ~~old~~\nnext line")).toBe(
    "<b>Plan &lt;v2&gt;</b>\n\nA &amp; B <b>bold <i>it</i></b> <code>a&lt;b&gt;</code> <s>old</s>\nnext line")
  expect(telegramHtml("```ts\nif (a < b) {}\n```")).toBe('<pre><code class="language-ts">if (a &lt; b) {}</code></pre>')
  expect(telegramHtml("[site](https://x.y/?a=1&b=2) [file](docs/x.md)")).toBe('<a href="https://x.y/?a=1&amp;b=2">site</a> file (docs/x.md)')
  expect(telegramHtml("- one\n  - nested\n- [x] done\n\n1. first\n2. second")).toBe("• one\n  • nested\n☑ done\n\n1. first\n2. second")
  expect(telegramHtml("> quote")).toBe("<blockquote>quote</blockquote>")
  expect(telegramHtml("| Tool | Purpose |\n|---|---|\n| read | Read files |\n| bash | Run `cmds` |")).toBe(
    "• <b>Tool</b>: read · <b>Purpose</b>: Read files\n• <b>Tool</b>: bash · <b>Purpose</b>: Run <code>cmds</code>")
  expect(telegramHtml("<script>x</script>")).toBe("&lt;script&gt;x&lt;/script&gt;")
})

test("send goes out as HTML, and as the same chunk in plain text when Telegram refuses the HTML", async () => {
  const calls: any[] = []
  let refuse = false
  const http: Http = async (url, init) => {
    const method = url.split("/").at(-1)!
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    if (method === "sendMessage") calls.push(body)

    if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 123, is_bot: true } }))
    if (method === "getWebhookInfo") return new Response(JSON.stringify({ ok: true, result: { url: "" } }))
    if (method === "sendMessage" && refuse && body.parse_mode) return new Response(JSON.stringify({ ok: false, error_code: 400 }), { status: 400 })
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }))
  }
  const home = realpathSync(mkdtempSync(join(tmpdir(), "empty-vessel-format-")))
  roots.push(home)

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const channel = yield* makeTelegramChannel({ token: Redacted.make("123:fake-test-only"), allowedUserId: "42", allowedChatId: "42" },
      { home, project: home, sendIntervalMs: 0, http })
    yield* channel.send("**done** & dusted")
    refuse = true
    yield* channel.send("**done** & dusted")
  })))

  expect(calls).toEqual([
    { chat_id: "42", text: "<b>done</b> &amp; dusted", parse_mode: "HTML" },
    { chat_id: "42", text: "<b>done</b> &amp; dusted", parse_mode: "HTML" },
    { chat_id: "42", text: "**done** & dusted" },
  ])
})
