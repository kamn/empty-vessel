import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scanSessions, renderIndex, startSessionBrowser, browserMain } from "../scripts/session-browser"
const dirs: string[] = []
const servers: Awaited<ReturnType<typeof startSessionBrowser>>["server"][] = []
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "session-browser-")); dirs.push(root); return root }
const log = (root: string, id: string, rows: unknown[]) => { mkdirSync(join(root, id)); writeFileSync(join(root, id, "main.jsonl"), rows.map(r => typeof r === "string" ? r : JSON.stringify(r)).join("\n")) }
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test("index scans all root sessions, preserves missing dates and counts corruption, and sorts by activity", async () => {
  const root = fixture()
  log(root, "old", [{ role: "user", text: "Older", ts: 5 }])
  log(root, "new", [{ role: "project", text: "/repo" }, { role: "user", text: "First request", ts: 10 }, { role: "user", text: "Later", ts: 20 }, "bad json"])
  log(root, "undated", [{ role: "user", text: "No date" }])
  log(root, "empty", [])
  log(join(root, "new"), "child", [{ role: "user", text: "Child", ts: 999 }])
  const summaries = await Effect.runPromise(scanSessions(root))
  expect(summaries.map(s => s.id)).toEqual(["new", "old", "empty", "undated"])
  expect(summaries[0]).toMatchObject({ title: "First request", project: "/repo", ts: 20, records: 4, malformed: 1 })
  expect(summaries.at(-1)?.ts).toBeUndefined()
  expect(summaries.find(s => s.id === "empty")?.records).toBe(0)
})

test("index escapes saved content and paginates instead of creating all list rows", () => {
  const html = renderIndex(Array.from({ length: 501 }, (_, i) => ({ id: String(i), title: '<script>BAD()</script>"', project: "<img>", records: i, malformed: 0 })))
  expect(html).not.toContain("<script>BAD()")
  expect(html).toContain("&lt;script&gt;")
  expect(html.match(/<script>/g)).toHaveLength(1)
  expect(html).toContain("script-src 'sha256-")
  expect(html).toContain("slice(page * 50, (page + 1) * 50)")
})

test("loopback browser lists sessions, drills down on demand, and reflects refreshed logs", async () => {
  const root = fixture()
  log(root, "session one", [{ role: "user", text: "Opening request", ts: 3 }])
  const browser = await startSessionBrowser(root)
  servers.push(browser.server)
  expect(browser.server.hostname).toBe("127.0.0.1")
  const index = await fetch(browser.url)
  expect(index.status).toBe(200)
  expect(index.headers.get("cache-control")).toBe("no-store")
  expect(await index.text()).toContain("Opening request")
  const notebook = await fetch(browser.url + "session/session%20one")
  const html = await notebook.text()
  expect(notebook.status).toBe(200)
  expect(html).toContain("← All sessions")
  expect(html).toContain('role="slider"')
  expect(html).toContain("Jev usage unavailable")
  log(root, "next", [{ role: "user", text: "New session", ts: 7 }])
  expect(await (await fetch(browser.url)).text()).toContain("New session")
  const head = await fetch(browser.url, { method: "HEAD" })
  expect(head.status).toBe(200)
  expect(await head.text()).toBe("")
})

test("browser rejects writes, wrong capabilities, foreign hosts, traversal, and external symlinks", async () => {
  const root = fixture(), outside = fixture()
  log(root, "valid", [{ role: "user", text: "Safe" }])
  log(outside, "private", [{ role: "user", text: "SECRET_OUTSIDE" }])
  symlinkSync(join(outside, "private"), join(root, "linked"))
  mkdirSync(join(root, "file-link"))
  symlinkSync(join(outside, "private", "main.jsonl"), join(root, "file-link", "main.jsonl"))
  const browser = await startSessionBrowser(root)
  servers.push(browser.server)
  for (const suffix of ["session/%2e%2e%2fprivate", "session/linked", "session/file-link", "session/missing"]) {
    const reply = await fetch(browser.url + suffix)
    expect(reply.status).toBe(404)
    expect(await reply.text()).not.toContain("SECRET_OUTSIDE")
  }
  expect((await fetch(browser.url, { method: "POST" })).status).toBe(405)
  expect((await fetch(new URL("/", browser.url))).status).toBe(404)
  expect((await fetch(browser.url, { headers: { Host: "external.example" } })).status).toBe(404)
  const summaries = await Effect.runPromise(scanSessions(root))
  expect(summaries.find(s => s.id === "file-link")?.error).toBeDefined()
  expect(JSON.stringify(summaries)).not.toContain("SECRET_OUTSIDE")
})

test("CLI validates arguments and provides a runnable help command", async () => {
  await Effect.runPromise(browserMain(["--help"]))
  for (const args of [["--root"], ["--port", "-1"], ["--port", "65536"], ["--unknown"]]) {
    expect((await Effect.runPromiseExit(browserMain(args)))._tag).toBe("Failure")
  }
})


// Exercise the actual standalone index script under its CSP, without dependencies.
test("browser index search, pagination, empty results, and safe drill-down links", async () => {
  const { existsSync, readFileSync } = await import("node:fs")
  const { createHash } = await import("node:crypto")
  const { pathToFileURL } = await import("node:url")
  const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  if (!existsSync(chrome)) return
  const dir = fixture()
  function probe() {
    try {
      const check = (condition: unknown, reason: string) => { if (!condition) throw new Error(reason) }
      const search = document.querySelector<HTMLInputElement>("#search")!
      const next = document.querySelector<HTMLButtonElement>("#next")!
      const previous = document.querySelector<HTMLButtonElement>("#previous")!
      const list = document.querySelector<HTMLElement>("#list")!
      const find = (query: string) => { search.value = query; search.dispatchEvent(new Event("input")) }
      check(list.children.length === 50, "first page is bounded")
      check(previous.disabled && !next.disabled, "initial page controls")
      next.click()
      check(list.children.length === 50 && list.textContent!.includes("Request 50"), "second page")
      next.click()
      check(list.children.length === 1 && next.disabled, "last page")
      find("needle")
      check(list.children.length === 1 && list.textContent!.includes("needle"), "search resets page")
      check(list.querySelector("a")!.getAttribute("href") === "session/session%20100", "safe encoded drill-down URL")
      find("no-such-session")
      check(list.textContent === "No matching sessions.", "explicit empty result")
      find("")
      check(list.children.length === 50, "clear search restores first page")
      check(!document.querySelector("#injected"), "saved title is text only")
      document.body.dataset.probe = "PASS"
    } catch (error) { document.body.dataset.probe = `FAIL: ${String(error)}` }
  }
  const script = `(${probe.toString()})();`
  const html = renderIndex(Array.from({ length: 101 }, (_, i) => ({ id: `session ${i}`, title: i === 100 ? "needle <img id=injected>" : `Request ${i}`, project: "", records: 1, malformed: 0, ts: i })))
    .replace("; style-src", ` 'sha256-${createHash("sha256").update(script).digest("base64")}'; style-src`)
    .replace("</body>", `<script>${script}</script></body>`)
  const path = join(dir, "index.html")
  writeFileSync(path, html)
  const proc = Bun.spawn([chrome, "--headless", "--no-sandbox", "--no-first-run", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--disable-default-apps", "--metrics-recording-only", `--user-data-dir=${join(dir, "profile")}`, "--virtual-time-budget=1000", "--dump-dom", pathToFileURL(path).href], { stdout: Bun.file(join(dir, "dom.html")), stderr: Bun.file(join(dir, "chrome.log")) })
  try {
    let result: string | undefined
    for (let i = 0; i < 400 && result === undefined; i++) {
      await Bun.sleep(50)
      result = readFileSync(join(dir, "dom.html"), "utf8").match(/data-probe="([^"]*)"/)?.[1]
    }
    expect(result).toBe("PASS")
  } finally { proc.kill(); await proc.exited }
}, 30_000)
