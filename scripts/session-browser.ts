// Loopback-only, read-only session index. Not an external dashboard or upload service.
import { Effect } from "effect"
import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { readdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve, sep } from "node:path"
import { createInterface } from "node:readline"
import { escapeHtml, parseSession, renderSession } from "./session-notebook"
import { loadUsage } from "./session-notebook-metrics"

export type SessionSummary = { id: string; title: string; project: string; records: number; malformed: number; ts?: number; error?: string }
const contained = async (root: string, path: string) => {
  const actual = await realpath(path)
  if (!actual.startsWith(root + sep)) throw new Error("Session is outside the selected store")
  return actual
}
export const scanSessions = (directory: string) => Effect.gen(function* () {
  const root = yield* Effect.promise(() => realpath(directory))
  const directories = yield* Effect.promise(() => readdir(root, { withFileTypes: true }))
  const summaries = yield* Effect.forEach(directories.filter(d => d.isDirectory()), d => Effect.promise(async () => {
    const summary: SessionSummary = { id: d.name, title: "No user request recorded", project: "", records: 0, malformed: 0 }
    let titleFound = false
    try {
      const source = await contained(root, join(root, d.name, "main.jsonl"))
      const lines = createInterface({ input: createReadStream(source, { encoding: "utf8" }), crlfDelay: Infinity })
      try {
        for await (const line of lines) {
          if (!line.trim()) continue
          summary.records++
          try {
            const row = JSON.parse(line)
            if (!row || typeof row.role !== "string" || typeof row.text !== "string") throw new Error("Invalid record")
            if (typeof row.ts === "number" && Number.isFinite(row.ts) && Number.isFinite(new Date(row.ts).getTime())) summary.ts = Math.max(summary.ts ?? -Infinity, row.ts)
            if (row.role === "user" && !titleFound && row.text.trim()) { summary.title = row.text.replace(/\s+/g, " ").slice(0, 240); titleFound = true }
            if (row.role === "project" && !summary.project) summary.project = row.text.replace(/\s+/g, " ").slice(0, 180)
          } catch { summary.malformed++ }
        }
      } finally { lines.close() }
    } catch { summary.error = "Log unavailable or outside this store" }
    return summary
  }), { concurrency: 8 })
  return summaries.sort((a, b) => (b.ts ?? -Infinity) - (a.ts ?? -Infinity) || a.id.localeCompare(b.id))
})

function installIndex() {
  const data = JSON.parse(document.querySelector<HTMLElement>("#sessions")!.dataset.sessions!) as SessionSummary[]
  const input = document.querySelector<HTMLInputElement>("#search")!
  const list = document.querySelector<HTMLElement>("#list")!
  const count = document.querySelector<HTMLElement>("#count")!
  const previous = document.querySelector<HTMLButtonElement>("#previous")!
  const next = document.querySelector<HTMLButtonElement>("#next")!
  let page = 0
  const render = () => {
    const query = input.value.trim().toLowerCase()
    const matches = data.filter(s => `${s.id} ${s.title} ${s.project}`.toLowerCase().includes(query))
    const pages = Math.max(1, Math.ceil(matches.length / 50))
    page = Math.min(page, pages - 1)
    list.replaceChildren()
    for (const session of matches.slice(page * 50, (page + 1) * 50)) {
      const li = document.createElement("li")
      const title = document.createElement(session.error ? "strong" : "a")
      title.textContent = session.title
      if (title instanceof HTMLAnchorElement) title.href = `session/${encodeURIComponent(session.id)}`
      const detail = document.createElement("p")
      detail.textContent = `${session.ts === undefined ? "Time not recorded" : new Date(session.ts).toLocaleString()} · ${session.records} records${session.malformed ? ` · ${session.malformed} malformed` : ""}${session.error ? ` · ${session.error}` : ""}`
      const meta = document.createElement("small")
      meta.textContent = `${session.id}${session.project ? ` · ${session.project}` : ""}`
      li.append(title, detail, meta)
      list.append(li)
    }
    count.textContent = `${matches.length} of ${data.length} sessions · Page ${page + 1} of ${pages}`
    if (!matches.length) { const empty = document.createElement("li"); empty.textContent = "No matching sessions."; list.append(empty) }
    previous.disabled = page === 0
    next.disabled = page + 1 === pages
  }
  input.addEventListener("input", () => { page = 0; render() })
  previous.addEventListener("click", () => { page--; render() })
  next.addEventListener("click", () => { page++; render() })
  render()
}
const indexScript = `(${installIndex.toString()})();`
export const renderIndex = (sessions: SessionSummary[]) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${createHash("sha256").update(indexScript).digest("base64")}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Session browser</title><style>body{max-width:960px;margin:30px auto;padding:0 18px;background:#faf9f6;color:#232b36;font:14px/1.5 system-ui}h1{margin-bottom:4px}a{color:#2859a1}input{box-sizing:border-box;width:100%;padding:12px;font:inherit;border:1px solid #aab4c0;border-radius:5px}ul{list-style:none;padding:0}li{background:white;border:1px solid #dde1e6;border-radius:5px;padding:12px;margin:8px 0;overflow-wrap:anywhere}li>a{font-weight:600}p{margin:5px 0}small{color:#586474}nav{display:flex;gap:12px;align-items:center;flex-wrap:wrap}button{padding:8px 14px;font:inherit}#count{color:#586474}a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid #2859a1;outline-offset:3px}</style></head><body><h1>Session browser</h1><p>Newest recorded activity first · root sessions · local, read-only</p><p><a href="./">Refresh session list</a> · Click a session to open its notebook and full-history minimap.</p><label for="search">Search request, project, or session ID</label><input id="search" type="search" placeholder="Search sessions…"><p id="count" role="status"></p><div id="sessions" data-sessions="${escapeHtml(JSON.stringify(sessions))}"><ul id="list"></ul></div><nav aria-label="Session pages"><button id="previous">Previous</button><button id="next">Next</button></nav><noscript>Enable JavaScript for search and pagination.</noscript><p><small>Only the selected notebook is rendered. Refresh to see new sessions; notebook pages are snapshots. Stop the command with Ctrl+C when finished.</small></p><script>${indexScript}</script></body></html>`

export const startSessionBrowser = async (directory: string, port = 0) => {
  const root = await realpath(directory)
  // Validate the store before listening; do not expose arbitrary paths in URLs.
  await readdir(root)
  const token = randomUUID()
  const base = `/${token}/`
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "frame-ancestors 'none'" }
  const server = Bun.serve({
    hostname: "127.0.0.1", port,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      if (request.headers.get("host") !== `127.0.0.1:${server.port}`) return new Response("Not found", { status: 404 })
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Read-only", { status: 405 })
      try {
        let html: string
        if (url.pathname === base) html = renderIndex(await Effect.runPromise(scanSessions(root)))
        else if (url.pathname.startsWith(base + "session/")) {
          const id = decodeURIComponent(url.pathname.slice((base + "session/").length))
          if (!id || id === "." || id === ".." || /[/\\\0]/.test(id)) return new Response("Not found", { status: 404 })
          const source = await contained(root, join(root, id, "main.jsonl"))
          const rows = parseSession(await Bun.file(source).text())
          const children = (await readdir(join(root, id), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)
          html = renderSession(source, rows, children, loadUsage(source)).replace('<header id="top">', `<header id="top"><p><a href="${base}">← All sessions</a></p>`)
        } else return new Response("Not found", { status: 404 })
        return new Response(request.method === "HEAD" ? null : html, { headers })
      } catch { return new Response("Session or store unavailable. Return to the session list and refresh.", { status: 404, headers }) }
    },
  })
  return { server, url: `http://127.0.0.1:${server.port}${base}` }
}

export const browserMain = (args: string[]) => Effect.gen(function* () {
  let root = join(process.env.EMPTY_VESSEL_HOME || join(homedir(), ".empty-vessel"), "sessions")
  let port = 0
  let open = true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--help" || arg === "-h") { console.log("Usage: bun run sessions [--root PATH] [--port 0-65535] [--no-open]\nLocal session list → click a notebook. Ctrl+C stops the server."); return }
    if (arg === "--no-open") open = false
    else if (arg === "--root" || arg === "--port") {
      const value = args[++i]
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`)
      if (arg === "--root") root = resolve(value)
      else { port = Number(value); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port") }
    } else throw new Error(`Unknown option: ${arg}`)
  }
  const browser = yield* Effect.promise(() => startSessionBrowser(root, port))
  console.log(`Session browser: ${browser.url}\nRead-only localhost server. Ctrl+C to stop.`)
  if (open) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : undefined
    if (opener) {
      const exit = yield* Effect.promise(() => Bun.spawn([opener, browser.url], { stdout: "ignore", stderr: "ignore" }).exited)
      if (exit !== 0) console.log("Browser did not open automatically; open the printed address.")
    }
  }
})
if (import.meta.main) Effect.runPromise(browserMain(process.argv.slice(2))).catch(error => { console.error(String(error)); process.exitCode = 1 })
