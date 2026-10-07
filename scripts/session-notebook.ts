// Read-only main.jsonl viewer. Does not execute cells or reconstruct missing provider data.
import { Effect } from "effect"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { randomInt, createHash } from "node:crypto"
import { minimapScript } from "./session-notebook-minimap"
import { loadUsage, metricsAt, usageByModel } from "./session-notebook-metrics"
import { recordedContext } from "./session-notebook-context"

export const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;")
type RecordRow = { line: number; role: string; text: string; raw: string; data?: Record<string, any>; ts?: number; malformed?: boolean }

export const parseSession = (text: string): RecordRow[] => text.split("\n").flatMap<RecordRow>((raw, i) => {
  if (!raw.trim()) return []

  try {
    const entry = JSON.parse(raw)
    if (!entry || typeof entry.role !== "string" || typeof entry.text !== "string") throw new Error("Invalid record")
    return [{ line: i + 1, role: entry.role, text: entry.text, raw, data: entry.role === "usage" && entry.extra && typeof entry.extra === "object" && !Array.isArray(entry.extra) ? { ...entry, ...entry.extra, role: entry.role, text: entry.text, ts: entry.ts } : entry, ts: typeof entry.ts === "number" && Number.isFinite(entry.ts) ? entry.ts : undefined }]
  } catch {
    return [{ line: i + 1, role: "Unreadable record", text: "Malformed or incomplete JSONL record; later records are still shown.", raw, malformed: true }]
  }
})

export const listSessions = (root: string): string[] => {
  if (!existsSync(root)) throw new Error(`Session store not found: ${root}. Use --root PATH.`)

  return readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory())
    .map(e => join(root, e.name, "main.jsonl"))
    .filter(p => existsSync(p) && statSync(p).isFile() && statSync(p).size > 0).sort()
}

export const pickSession = (paths: string[], index: (max: number) => number = randomInt) => {
  if (!paths.length) throw new Error("No nonempty root session logs found.")
  return paths[index(paths.length)]!
}

export const recentSessions = (paths: string[], count: number) => {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("--recent must be a positive integer")
  return paths.map(path => ({ path, ts: parseSession(readFileSync(path, "utf8")).reduce((latest, row) => Math.max(latest, row.ts ?? -Infinity), -Infinity) }))
    .filter(entry => Number.isFinite(entry.ts)).sort((a, b) => b.ts - a.ts || a.path.localeCompare(b.path)).slice(0, count).map(entry => entry.path)
}

const dateLabel = (ts?: number) => ts === undefined || !Number.isFinite(new Date(ts).getTime()) ? "Time not recorded" : new Date(ts).toISOString()
const labels: Record<string, string> = { user: "You", assistant: "Assistant", decision: "Decision", step: "Step", check: "Check", command: "Command", code: "Code", spawn: "Agent", result: "Result", steer: "Interruption", memory: "Memory", thread: "Thread", stash: "Stored output", usage: "Usage" }
const folds = new Set(["decision", "thread", "stash", "size", "shown", "tools", "given", "project", "usage"])

const numberLabel = (n?: number) => n === undefined ? "not recorded" : n.toLocaleString("en-US")
type UsageReport = Pick<ReturnType<typeof loadUsage>, "samples" | "source" | "note">
const noUsage: UsageReport = { samples: [], note: "No matching usage recording loaded." }

export const renderSession = (source: string, rows: RecordRow[], children: string[] = [], usage: UsageReport = noUsage) => {
  const id = basename(dirname(source))
  const metrics = metricsAt(rows, usage.samples)
  const systemOne = metricsAt(rows, usage.samples.filter(s => s.system === "systemOne"))
  const systemTwo = metricsAt(rows, usage.samples.filter(s => s.system === "systemTwo"))
  const jevAvailable = usage.samples.some(s => s.system === "systemOne")
  const systemTwoAvailable = usage.samples.some(s => s.system === "systemTwo")
  const coverage = `${jevAvailable ? "System 1 / Jev usage recorded" : "Jev usage unavailable"} · ${systemTwoAvailable ? "System 2 usage recorded" : "System 2 usage unavailable"}`
  const lastTs = [...rows, ...usage.samples].reduce((last, row) => row.ts !== undefined && Number.isFinite(new Date(row.ts).getTime()) ? Math.max(last, row.ts) : last, 0)
  const final = metricsAt([...rows, { role: "viewer-end", text: "", ts: lastTs }], usage.samples).at(-1)!
  const usedTools = [...new Set(rows.filter(r => r.role === "command").map(r => r.text).filter(Boolean))].sort()
  const context = recordedContext(rows)
  const models = usageByModel(usage.samples)
  const loadedNames = [...new Set(context.sources.flatMap(s => s.unavailable === undefined ? s.tools.map(t => `${s.name}.${t}`) : []))]
  const compactNames = loadedNames.slice(0, 3).map(escapeHtml).join(", ") + (loadedNames.length > 3 ? ` +${loadedNames.length - 3} more` : "")
  const modelSection = `<section class="model-usage" aria-labelledby="model-heading"><h2 id="model-heading">Recorded usage by model</h2><p class="small usage-coverage">${escapeHtml(coverage)}</p>${models.length ? `<div class="table-scroll" tabindex="0" aria-label="Model token breakdown"><table><thead><tr><th scope="col">Model</th><th scope="col">${usage.samples.some(s => s.granularity === "provider-result") ? "Usage records" : "Calls"}</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Cached input¹</th><th scope="col">Reasoning out¹</th></tr></thead><tbody>${models.map(m=>`<tr><th scope="row">${escapeHtml(m.model)}</th><td>${m.calls}</td><td>${numberLabel(m.input)}</td><td>${numberLabel(m.output)}</td><td>${numberLabel(m.cached)}</td><td>${numberLabel(m.thinking)}</td></tr>`).join("")}</tbody></table></div><p class="small">¹ Subsets, already included in input/output. Recorded root-agent calls only; unknown model names stay separate.</p>` : '<p class="small">No model-attributed usage recording available. Current model configuration is not substituted. Missing systems are not counted as zero.</p>'}</section>`
  const sourceDetails = context.sources.map(s=>`<div class="source-entry"><strong>${escapeHtml(s.name)}</strong> · ${s.unavailable !== undefined ? `listed unavailable: ${escapeHtml(s.unavailable)}` : s.tools.length ? s.tools.map(t=>`<code>${escapeHtml(t)}</code>`).join(", ") : 'no tool names in declaration'}<span class="small"> · first recorded <a href="#event-${s.firstLine}">#${s.firstLine}</a>${s.lastLine !== s.firstLine ? ` · last <a href="#event-${s.lastLine}">#${s.lastLine}</a>` : ""} · ${s.sightings} prompt declaration${s.sightings === 1 ? "" : "s"}</span>${s.instructions ? `<details><summary>Instructions loaded into the saved prompt</summary><pre>${escapeHtml(s.instructions)}</pre></details>` : '<p class="small">Source instructions not present in this declaration.</p>'}</div>`).join("")
  const contextSection = `<details class="setup" id="setup"><summary><strong>Tools &amp; skills</strong> · ${loadedNames.length ? `in saved context: ${compactNames}` : context.sources.length ? 'source declarations recovered; none listed available' : 'startup snapshot unavailable'} · ${usedTools.length} tool names observed</summary><div>${context.sources.length ? `<p><strong>Tool context recovered from saved prompts</strong> — not inferred from calls or current settings. First recorded appearance is not necessarily the original loading time.</p>${sourceDetails}<p class="small">These are recorded source declarations and supplied instructions, not proof a tool was invoked or that every tool schema was included. This is not a complete startup inventory.</p>` : '<p><strong>Tools:</strong> startup inventory not established. No supported tool-source declaration was found in saved user-prompt envelopes.</p>'}<p><strong>Recorded command names:</strong> ${usedTools.length ? usedTools.map(t=>`<code>${escapeHtml(t)}</code>`).join(", ") : "none"}. Used during this session—not a list of tools available at startup. A kernel call does not establish which external tool it invoked.</p>${context.handedTools.length ? `<p><strong>Library tools handed to System One:</strong> ${context.handedTools.map(t=>`<a href="#event-${t.line}">${escapeHtml(t.name)}</a>`).join(", ")}</p>` : ""}<details><summary>Files supplied as context · ${context.files.length}</summary>${context.files.map(f=>`<p class="small"><a href="#event-${f.line}">${escapeHtml(f.name)}</a></p>`).join("") || '<p class="small">No supplied-file records found.</p>'}</details><p><strong>Skills:</strong> startup inventory not established. Tool names and the instruction “prioritize skills” do not establish that a skill was loaded. Native tool schemas and skill instructions may not be serialized in these logs.</p></div></details>`

  const metricsText = (m: typeof final) => `Last request context: ${numberLabel(m.context)} tokens${m.contextTs === undefined ? "" : ` (snapshot ${dateLabel(m.contextTs)})`}\nRecorded input so far: ${numberLabel(m.input)} tokens\nRecorded output so far: ${numberLabel(m.output)} tokens\nInput + output: ${numberLabel(m.input === undefined || m.output === undefined ? undefined : m.input + m.output)} tokens\nCached input (subset): ${numberLabel(m.cached)}\nReasoning output (subset): ${numberLabel(m.thinking)}\n${usage.samples.some(s => s.granularity === "provider-result") ? "Recorded usage records (includes provider aggregates)" : "Recorded calls"}: ${m.calls}\nRoot agent only; missing calls cannot be reconstructed.`
  const rawRecord = (row: RecordRow) => `<details class="raw"><summary>Original record · full saved JSON</summary><pre>${escapeHtml(row.raw)}</pre></details>`
  const summaryOf = (row: RecordRow) => String(row.data?.args?.summary ?? (row.role === "usage" ? `${row.data?.system ?? "unknown system"} · ${row.data?.model ?? "model not recorded"} · ${row.data?.input ?? "?"} in / ${row.data?.output ?? "?"} out · ${row.data?.agent ?? "agent not recorded"}` : row.role === "thread" ? `Provider payload · ${row.data?.item?.role ?? "unknown role"}` : row.text || row.role)).replace(/\s+/g, " ")

  const timeline = rows.map((row, i) => {
    const m = metrics[i]!
    const split = `System 1 / Jev so far: ${systemOne[i]!.calls ? `${numberLabel(systemOne[i]!.input)} in / ${numberLabel(systemOne[i]!.output)} out` : "Jev usage unavailable"}\nSystem 2 so far: ${systemTwo[i]!.calls ? `${numberLabel(systemTwo[i]!.input)} in / ${numberLabel(systemTwo[i]!.output)} out` : "usage unavailable"}`
    const description = `${labels[row.role] ?? row.role} · record ${row.line}\n${dateLabel(row.ts)}\n${metricsText(m)}\n${split}`
    return { line: row.line, label: `${labels[row.role] ?? row.role} · ${summaryOf(row).slice(0, 100)}`, description, kind: row.role }
  })
  const scriptHash = createHash("sha256").update(minimapScript).digest("base64")

  const events = rows.map((row, i) => {
    const command = row.role === "command" && row.text === "kernel" && typeof row.data?.args?.code === "string"
    const muted = folds.has(row.role) || row.role === "systemTwo" || row.role === "actions"
    const content = command
      ? `<div class="execution-title"><strong>${escapeHtml(summaryOf(row))}</strong><span class="small">In · record ${row.line} (not a kernel cell number)</span></div><pre class="code">${escapeHtml(row.data!.args.code)}</pre><details class="output"><summary>Out · saved output excerpt; completeness not established</summary><pre>${escapeHtml(typeof row.data?.output === "string" ? row.data.output : "Output not recorded")}</pre></details>${rawRecord(row)}`
      : muted
        ? `<details class="quiet"><summary>${escapeHtml(summaryOf(row).slice(0, 150))}${summaryOf(row).length > 150 ? "…" : ""}</summary>${row.text ? `<pre>${escapeHtml(row.text)}</pre>` : ""}${rawRecord(row)}</details>`
        : `<pre>${escapeHtml(row.text)}</pre>${rawRecord(row)}`
    return `<section class="event ${muted ? "muted" : ""}" id="event-${row.line}"><div class="gutter">${escapeHtml(labels[row.role] ?? row.role)}<br><a href="#event-${row.line}" aria-label="Record ${row.line}">${row.line}</a></div><article class="${row.malformed ? "error" : ""}">${muted ? "" : `<div class="meta"><span>${escapeHtml(dateLabel(row.ts))}</span><span title="Last recorded request input; not live context size">ctx ${escapeHtml(numberLabel(metrics[i]!.context))}</span></div>`}${content}</article></section>`
  }).join("\n")

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Session ${escapeHtml(id)}</title><style>
  *{box-sizing:border-box}html{scroll-padding-top:18px}body{margin:0;background:#faf9f6;color:#232b36;font:13px/1.5 system-ui,sans-serif}a{color:#2859a1}button,summary,a{-webkit-tap-highlight-color:transparent}a:focus-visible,summary:focus-visible{outline:2px solid #2859a1;outline-offset:3px}.skip{position:absolute;top:-100px}.skip:focus{top:0;background:white;padding:10px;z-index:20}.shell{display:grid;grid-template-columns:64px minmax(0,1030px);gap:18px;max-width:1200px;margin:24px auto;padding:0 18px 40px}main{min-width:0}header h1{font-size:23px;letter-spacing:-.025em;margin:4px 0}header p{margin:5px 0}.small,.meta{color:#586474;font-size:11px}.eyebrow{font-size:10px;letter-spacing:.12em;font-weight:700}.session-id{font-size:10px;color:#586474;overflow-wrap:anywhere}.stats{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0 8px}.stat{border:1px solid #d9dee3;border-radius:5px;background:white;padding:6px 10px;min-width:100px}.stat strong{font-size:16px;display:block;font-variant-numeric:tabular-nums}.stat span{font-size:10px;color:#586474}.setup{border-block:1px solid #d9dee3;padding:4px 0;margin:8px 0 16px}.setup p{font-size:12px;margin:7px 0}.coverage{margin:10px 0;color:#586474;font-size:11px}summary{cursor:pointer;padding:4px 0;overflow-wrap:anywhere}details>div{padding:5px 4px}.event{display:grid;grid-template-columns:56px minmax(0,1fr);gap:9px;margin:10px 0}.gutter{font:10px/1.5 ui-monospace,monospace;color:#2859a1;text-align:right;padding-top:9px;overflow-wrap:anywhere}.gutter a{font-size:9px;color:#586474;text-decoration:none}article{min-width:0;padding:9px 12px;border:1px solid #dde1e6;border-radius:5px;background:white}.meta{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:3px;font-size:10px}.execution-title{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:6px 0}.execution-title strong{font-size:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 ui-monospace,SFMono-Regular,monospace;margin:6px 0;max-height:320px;overflow:auto}.code{max-height:180px;background:#f6f7f9;padding:9px;border-radius:3px}.raw{margin-top:5px;border-top:1px solid #eceef0;padding-top:2px}.raw summary{font-size:10px;color:#586474}.raw pre{font-size:11px}.output summary{color:#26654d;font-size:11px}.muted{margin:3px 0}.muted article{padding:3px 10px;background:transparent;border-color:transparent}.muted .gutter{padding-top:6px;font-size:9px}.quiet>summary{font-size:11px;color:#586474}.error{border-color:#a13939}.event:target article{border-color:#2859a1;box-shadow:0 0 0 1px #2859a1}code{overflow-wrap:anywhere}footer{margin:20px 0;font-size:11px;color:#586474}.shell>main{grid-column:2}.rail{position:fixed;left:max(18px,calc((100vw - 1200px)/2 + 18px));width:64px;top:12px;height:calc(100vh - 24px);height:calc(100dvh - 24px);display:flex;flex-direction:column;align-items:center;gap:6px;min-height:0}.rail h2{font-size:10px;margin:0}.rail>p{font-size:9px;color:#586474;margin:0;text-align:center}.rail>a{font-size:10px}.minimap{position:relative;width:44px;flex:1;min-height:0;cursor:crosshair;touch-action:none;border-radius:4px;background:#eef0f3}.minimap:focus-visible{outline:2px solid #2859a1;outline-offset:2px}.minimap canvas{position:absolute;width:40px;height:100%;left:2px;top:0;pointer-events:none}.minimap-status{font-size:9px;font-variant-numeric:tabular-nums}.minimap-tip{position:fixed;left:max(95px,calc((100vw - 1200px)/2 + 95px));top:80px;max-height:calc(100dvh - 100px);overflow:hidden;width:min(330px,calc(100vw - 110px));white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;background:white;border:1px solid #b5c2d5;border-radius:6px;box-shadow:0 8px 32px #17253626;z-index:10;pointer-events:none;font-size:11px}.minimap-tip[hidden]{display:none}
  .model-usage h2{font-size:12px;margin:12px 0 5px}.table-scroll{overflow:auto}.model-usage table{width:100%;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}.model-usage th,.model-usage td{padding:5px 8px;border-bottom:1px solid #e2e5e9;text-align:right;white-space:nowrap}.model-usage th:first-child{text-align:left;max-width:300px;white-space:normal;overflow-wrap:anywhere}.model-usage thead th{color:#586474;font-size:10px;font-weight:600}.source-entry{padding:6px 0;border-bottom:1px solid #e2e5e9}.source-entry summary{font-size:11px}.source-entry pre{font-size:11px;max-height:220px}
  @media(max-width:760px){.shell{grid-template-columns:44px minmax(0,1fr);gap:8px;margin-top:12px;padding:0 8px 30px}.rail{left:8px;width:44px}.rail h2,.rail>p{display:none}.minimap-tip{left:60px;width:calc(100vw - 72px)}.event{grid-template-columns:36px minmax(0,1fr);gap:5px}article{padding:7px}.stat{min-width:85px}.stat strong{font-size:14px}}
  @media print{.rail,.skip{display:none}.shell{display:block}pre{max-height:none}details:not([open])::after{content:"Collapsed detail — open HTML to inspect";font-size:9px;color:#586474}}
  </style></head><body><a href="#notebook" class="skip">Skip timeline</a><div class="shell"><aside class="rail" aria-label="Session timeline"><h2>History</h2><a href="${rows.length ? `#event-${rows[0]!.line}` : "#top"}">Start</a><div class="minimap" role="slider" tabindex="0" aria-label="Session history: click to jump; arrows move one record; Home and End jump to endpoints" aria-orientation="vertical" aria-valuemin="${rows.length ? 1 : 0}" aria-valuemax="${rows.length}" aria-valuenow="${rows.length ? 1 : 0}" aria-describedby="minimap-tip" data-entries="${escapeHtml(JSON.stringify(timeline))}"><canvas aria-hidden="true"></canvas></div><a href="${rows.length ? `#event-${rows.at(-1)!.line}` : "#top"}">End</a><span class="minimap-status" id="minimap-status">${rows.length} records</span><p>Hover for tokens<br>Click to jump</p><noscript>Use Start / End links; the full minimap needs JavaScript.</noscript></aside><div id="minimap-tip" class="minimap-tip" role="tooltip" hidden></div><main id="notebook"><header id="top"><div class="eyebrow">EMPTY VESSEL / RECORDED SESSION</div><h1>Session notebook</h1><p class="session-id">${escapeHtml(id)} · ${rows.length} records · read-only snapshot</p>
  <div class="stats"><div class="stat"><strong>${numberLabel(final.context)}</strong><span>Last request context · tokens</span></div><div class="stat"><strong>${numberLabel(final.input)}</strong><span>Recorded input · cumulative</span></div><div class="stat"><strong>${numberLabel(final.output)}</strong><span>Recorded output · cumulative</span></div><div class="stat"><strong>${numberLabel(final.input === undefined || final.output === undefined ? undefined : final.input + final.output)}</strong><span>Input + output · cumulative</span></div></div>
  ${modelSection}
  ${contextSection}
  <details class="coverage"><summary>Sources &amp; metric definitions · ${usage.samples.length} recorded calls · root agent only</summary><div><p><strong>Context</strong> is the latest saved System Two request input size, not an exact live context or a model-window limit. Hover an event to see the snapshot timestamp. Cumulative input/output measure recorded usage across requests; they are not context size.</p><p>Usage events identify their system, model, agent and timestamp. Primary usage records and matching mirror copies share an ID and are counted once. Older mirror-only periods can be incomplete; missing Jev usage is not zero. Provider-result aggregates, where supplied by a provider, are not a count of individual requests. Cached tokens are already included in input; reasoning tokens are already included in output. Never add these subsets twice. Missing values stay “not recorded,” not zero. ${escapeHtml(usage.note)}</p><p>Usage source: <code>${escapeHtml(usage.source ?? "none")}</code><br>Session source: <code>${escapeHtml(source)}</code></p><p>Root agent only. Child logs and their usage are excluded: ${escapeHtml(children.join(", ") || "none found")}. Kernel sidecar files are not imported. Original saved records remain expandable; upstream truncation cannot be recovered. Provider thread payloads are not fully decoded. Claims in the session are not independently verified. The end-of-recording counters can include usage recorded after the last main-log event.</p></div></details></header>${events || '<p>No nonblank records found.</p>'}<footer>Private local snapshot · no code execution, uploads, or external requests. <a href="#top">Back to top ↑</a></footer></main></div><script>${minimapScript}</script></body></html>`
}

const help = `Usage: bun scripts/session-notebook.ts [--random | SESSION_ID | SESSION_DIR | main.jsonl] [--recent N] [--open]
       bun scripts/session-notebook.ts --list
Options: --root PATH (default ~/.empty-vessel/sessions), --output PATH
Default output: sibling empty-vessel-research/local-eval/results/session-ID.html
--recent N draws from the N sessions with the latest recorded timestamps.
Reads main.jsonl only. Keeps all records; does not execute or upload anything.`

export const main = (args: string[]) => Effect.gen(function* () {
  const result = yield* Effect.try(() => {
    let root = join(homedir(), ".empty-vessel", "sessions")
    let output: string | undefined
    let target: string | undefined
    let open = false
    let list = false
    let recent: number | undefined

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!
      if (arg === "--help" || arg === "-h") return { message: help }
      if (arg === "--root" || arg === "--output" || arg === "--recent") {
        const value = args[++i]
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`)
        if (arg === "--root") root = resolve(value)
        else if (arg === "--output") output = resolve(value)
        else {
          recent = Number(value)
          if (!Number.isSafeInteger(recent) || recent < 1) throw new Error("--recent must be a positive integer")
        }
      } else if (arg === "--open") open = true
      else if (arg === "--list") list = true
      else if (arg.startsWith("--") && arg !== "--random") throw new Error(`Unknown option: ${arg}`)
      else {
        if (target) throw new Error("Choose only one session or --random.")
        target = arg
      }
    }

    if (list) return { message: listSessions(root).map(p => basename(dirname(p))).join("\n") || "No sessions found." }
    if (!target) return { message: help }

    let source: string
    if (target === "--random") {
      const candidates = listSessions(root)
      source = pickSession(recent === undefined ? candidates : recentSessions(candidates, recent))
    }
    else {
      const location = existsSync(target) ? resolve(target) : join(root, target)
      source = existsSync(location) && statSync(location).isDirectory() ? join(location, "main.jsonl") : location
    }

    if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Session log not found: ${source}`)
    const rows = parseSession(readFileSync(source, "utf8"))
    const children = readdirSync(dirname(source), { withFileTypes: true }).filter(e => e.isDirectory() && existsSync(join(dirname(source), e.name, "main.jsonl"))).map(e => e.name)
    const id = basename(dirname(source)).replace(/[^a-zA-Z0-9_-]/g, "_")
    const destination = output ?? resolve(import.meta.dir, "../../empty-vessel-research/local-eval/results", `session-${id}.html`)
    if (resolve(destination) === resolve(source)) throw new Error("Output must not overwrite the input log.")
    if (existsSync(destination)) throw new Error(`Output already exists: ${destination}. Use --output with a new filename.`)

    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, renderSession(source, rows, children, loadUsage(source)), { mode: 0o600, flag: "wx" })
    return { message: `Session: ${basename(dirname(source))}\nRecords: ${rows.length}\nSaved: ${destination}`, destination, open }
  })

  console.log(result.message)
  if (result.destination && result.open) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? null : "xdg-open"
    if (!opener) { console.log("Open the saved HTML file in your browser."); return }
    const exit = yield* Effect.tryPromise(() => Bun.spawn([opener, result.destination!], { stdout: "ignore", stderr: "inherit" }).exited)
    if (exit !== 0) return yield* Effect.fail(new Error("Browser opener failed; open the saved HTML file manually."))
  }
})

if (import.meta.main) Effect.runPromise(main(process.argv.slice(2))).catch(error => { console.error(String(error)); process.exitCode = 1 })
