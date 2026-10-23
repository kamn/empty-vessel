import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { Effect } from "effect"
import { importSkill, SKILL_IMPORT_LIMITS } from "./skill-import"
import { describeFlags, type Scan, scanSkill } from "./skill-scan"
import { discoverSkills, message, SKILL_LIMITS, SkillError, validateSkillBytes } from "./skills"

// The skills hub (KTD22): skills downloaded on the host (cells can't fetch), over HTTPS only, from a GitHub folder, a
// SKILL.md URL, or an Agent Skills discovery index (/.well-known/agent-skills/index.json). What's downloaded is listed
// and scanned, the user confirms, then importSkill installs it with its origin in the receipt. Nothing in it is run.
export type Http = (url: string, init: RequestInit) => Promise<Response>
export type RemoteFile = { readonly path: string; readonly bytes: Buffer }
export type Download = { readonly name: string; readonly origin: { readonly url: string; readonly sha256?: string }; readonly files: ReadonlyArray<RemoteFile> }
export type IndexEntry = { readonly name: string; readonly type: string; readonly description: string; readonly url: string; readonly sha256?: string }

export const WELL_KNOWN = "/.well-known/agent-skills/index.json"
const INDEX_BYTES = 1024 * 1024
const REDIRECTS = 5
const GITHUB = /^([\w.-]+)\/([\w.-]+)\/([^@\s]+?)\/?(?:@(\S+))?$/
const USAGE = "Install from owner/repo/path[@ref] (GitHub), an https:// SKILL.md URL, or <index-url>#<name> (/skills browse lists them)"

const fail = (message: string) => Effect.fail(new SkillError({ message }))
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const https = (url: string) => URL.canParse(url) && new URL(url).protocol === "https:"

// A remote relative path: plain segments only (no absolute path, no ., .., empty part or backslash).
const safePath = (path: unknown): path is string =>
  typeof path === "string" && !/[\\\0]/.test(path) && path.split("/").every((part) => part && part !== "." && part !== "..")

// The body, stopped as soon as it is larger than `cap`.
const body = (response: Response, cap: number, url: string) => Effect.gen(function* () {
  const reader = response.body?.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0

  while (reader) {
    const chunk = yield* Effect.tryPromise({ try: () => reader.read(), catch: (e) => new SkillError({ message: `Couldn't read ${url}: ${message(e)}` }) })
    if (chunk.done) break
    size += chunk.value.length

    if (size > cap) {
      void reader.cancel()
      return yield* fail(`${url} is larger than ${cap} bytes`)
    }

    chunks.push(chunk.value)
  }

  return Buffer.concat(chunks)
})

// One GET. Redirects are followed here, a hop at a time, so none can step down to http.
const get = (http: Http, url: string, cap: number, headers: Record<string, string> = {}): Effect.Effect<Buffer, SkillError> => Effect.gen(function* () {
  let at = url

  for (let hop = 0; ; hop++) {
    if (!https(at)) return yield* fail(`HTTPS only: ${at}`)
    const response = yield* Effect.tryPromise({ try: () => http(at, { redirect: "manual", headers }), catch: (e) => new SkillError({ message: `Couldn't fetch ${at}: ${message(e)}` }) })
    if (response.url && !https(response.url)) return yield* fail(`HTTPS only: ${response.url}`)
    const location = response.headers.get("location")

    if (response.status >= 300 && response.status < 400 && location) {
      if (hop >= REDIRECTS) return yield* fail(`Too many redirects from ${url}`)
      at = new URL(location, at).href
      continue
    }

    if (!response.ok) return yield* fail(`Couldn't fetch ${at}: HTTP ${response.status}`)
    return yield* body(response, cap, at)
  }
})

const json = (http: Http, url: string, cap: number, headers?: Record<string, string>) => get(http, url, cap, headers).pipe(
  Effect.flatMap((bytes) => Effect.try({ try: (): unknown => JSON.parse(bytes.toString("utf8")), catch: () => new SkillError({ message: `${url} isn't JSON` }) })))

// A GitHub folder through the contents API: listed whole first (every path checked, no symlinks or submodules), then
// each file fetched by its download_url, within the import limits.
const fromGitHub = (http: Http, owner: string, repo: string, path: string, ref?: string) => Effect.gen(function* () {
  const headers = { accept: "application/vnd.github+json", "user-agent": "empty-vessel" }
  const api = (folder: string) => `https://api.github.com/repos/${owner}/${repo}/contents/${folder.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`
  const listed: Array<{ path: string; url: string }> = []

  const list = (folder: string): Effect.Effect<void, SkillError> => Effect.gen(function* () {
    const items = yield* json(http, api(folder), INDEX_BYTES, headers)
    if (!Array.isArray(items)) return yield* fail(`${owner}/${repo}/${folder} isn't a folder: point at the skill's folder`)

    for (const item of items as Array<Record<string, unknown>>) {
      const full = item?.path
      const relative = typeof full === "string" && full.startsWith(`${path}/`) ? full.slice(path.length + 1) : undefined
      if (!safePath(relative)) return yield* fail(`Refused an unsafe path from GitHub: ${JSON.stringify(full)}`)
      if (item.type === "dir") { yield* list(`${path}/${relative}`); continue }
      if (item.type !== "file") return yield* fail(`Refused ${relative}: a ${String(item.type)} entry (symlinks and submodules aren't installed)`)
      if (typeof item.download_url !== "string") return yield* fail(`GitHub gave no download_url for ${relative}`)
      if (listed.length >= SKILL_IMPORT_LIMITS.entries) return yield* fail(`Skill package exceeds ${SKILL_IMPORT_LIMITS.entries} entries`)
      listed.push({ path: relative, url: item.download_url })
    }
  })
  yield* list(path)

  const files: Array<RemoteFile> = []
  let total = 0

  for (const file of listed) {
    const bytes = yield* get(http, file.url, SKILL_IMPORT_LIMITS.bytes - total)
    total += bytes.length
    files.push({ path: file.path, bytes })
  }

  return { name: path.split("/").at(-1)!, origin: { url: api(path) }, files } satisfies Download
})

// A site's discovery index: its URL, or the site's (https://example.com → its /.well-known/agent-skills/index.json).
export const indexUrl = (source: string) => {
  const url = new URL(source)
  if (url.pathname === "/") url.pathname = WELL_KNOWN
  url.hash = ""
  return url.href
}

export const readIndex = (http: Http, source: string): Effect.Effect<{ url: string; entries: ReadonlyArray<IndexEntry> }, SkillError> => Effect.gen(function* () {
  if (!https(source)) return yield* fail(`HTTPS only: ${source}`)
  const url = indexUrl(source)
  const index = (yield* json(http, url, INDEX_BYTES)) as { skills?: unknown }
  if (!Array.isArray(index?.skills)) return yield* fail(`${url} isn't an Agent Skills index (no skills list)`)

  const entries = (index.skills as Array<Record<string, unknown>>).filter((e) => e && typeof e.name === "string" && typeof e.url === "string").map((e) => {
    const digest = typeof e.digest === "string" && e.digest.startsWith("sha256:") ? e.digest.slice(7) : typeof e.sha256 === "string" ? e.sha256 : undefined
    return { name: e.name as string, type: String(e.type ?? "skill-md"), description: String(e.description ?? ""), url: new URL(e.url as string, url).href, ...(digest ? { sha256: digest.toLowerCase() } : {}) }
  })
  return { url, entries }
})

// One index entry, its SKILL.md checked against the index's sha256.
const fromIndex = (http: Http, source: string, name: string) => Effect.gen(function* () {
  const { url, entries } = yield* readIndex(http, source)
  const entry = entries.find((e) => e.name === name)
  if (!entry) return yield* fail(`No skill ${name} in ${url}`)
  if (entry.type === "archive") return yield* fail(`${name}: archive entries are not supported yet`)
  if (entry.type !== "skill-md") return yield* fail(`${name}: unknown entry type ${entry.type}`)
  if (!entry.sha256) return yield* fail(`${name}: the index gives no sha256 digest, so it can't be checked`)

  const bytes = yield* get(http, entry.url, SKILL_LIMITS.file)
  const got = sha(bytes)
  if (got !== entry.sha256) return yield* fail(`${name}: sha256 mismatch (index ${entry.sha256}, downloaded ${got}); not installed`)
  return { name, origin: { url: entry.url, sha256: got }, files: [{ path: "SKILL.md", bytes }] } satisfies Download
})

export const fetchSkill = (source: string, http: Http): Effect.Effect<Download, SkillError> => {
  const github = GITHUB.exec(source)
  if (github && !source.includes(":")) return fromGitHub(http, github[1]!, github[2]!, github[3]!, github[4])
  if (!https(source)) return fail(`HTTPS only: ${source}. ${USAGE}`)

  const url = new URL(source)
  if (url.hash) return fromIndex(http, source, decodeURIComponent(url.hash.slice(1)))
  if (url.pathname === "/" || url.pathname.endsWith(".json")) return fail(`Name the skill: <index-url>#<name>. ${USAGE}`)

  return get(http, source, SKILL_LIMITS.file).pipe(Effect.map((bytes): Download => ({
    name: url.pathname.split("/").at(-2) || "skill", origin: { url: source, sha256: sha(bytes) }, files: [{ path: "SKILL.md", bytes }],
  })))
}

// Every file with its size and its own flags, for the user to read before confirming.
export const describeDownload = (download: Download, scan: Scan) => [
  `${download.name} from ${download.origin.url}${download.origin.sha256 ? ` (sha256 ${download.origin.sha256})` : ""}:`,
  ...download.files.map((file) => [`  ${file.path} (${file.bytes.length} B)`,
    ...scan.flags.filter((f) => f.file === file.path).map((f) => `    ${f.severity} ${f.kind}: ${f.detail}`)].join("\n")),
].join("\n")

// Written into the temp folder only: each path checked once more against it.
const stage = (download: Download, folder: string) => Effect.try({
  try: () => {
    for (const file of download.files) {
      const target = resolve(folder, file.path)
      if (!safePath(file.path) || !target.startsWith(folder + sep)) throw new SkillError({ message: `Refused an unsafe path: ${file.path}` })
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.bytes, { flag: "wx", mode: 0o644 }) // never runnable
    }

    return folder
  },
  catch: (error) => error instanceof SkillError ? error : new SkillError({ message: `Couldn't stage the skill: ${message(error)}` }),
})

export type Confirm = (summary: string, files: ReadonlyArray<RemoteFile>) => Effect.Effect<boolean>

/** Download, scan (a dangerous verdict refuses before asking), confirm, install. Undefined: the user said no. */
export const installSkill = (source: string, options: { scope: "project" | "personal"; cwd: string; home: string; http: Http; confirm: Confirm }) => Effect.gen(function* () {
  const download = yield* fetchSkill(source, options.http)
  const scan = scanSkill(download.files.map((f) => ({ path: f.path, text: f.bytes.toString("utf8") })))
  const summary = describeDownload(download, scan)
  if (scan.verdict === "dangerous") return yield* fail(`Refused by the skill scan: ${describeFlags(scan.flags.filter((f) => f.severity === "dangerous"))}\n${summary}`)

  const skill = download.files.find((f) => f.path === "SKILL.md")
  if (!skill) return yield* fail(`${download.name} has no SKILL.md`)
  const { name } = yield* Effect.try({ try: () => validateSkillBytes(skill.bytes, download.name), catch: (e) => e instanceof SkillError ? e : new SkillError({ message: message(e) }) })
  const existing = discoverSkills(options.cwd, options.home).skills.find((s) => s.name === name && s.source === options.scope)
  if (existing) return yield* fail(`${name} is already installed: ${existing.path}`)

  if (!(yield* options.confirm(summary, download.files))) return undefined
  return yield* Effect.acquireUseRelease(Effect.sync(() => mkdtempSync(join(tmpdir(), "empty-vessel-skill-"))),
    (temp) => stage(download, join(temp, name)).pipe(Effect.flatMap((folder) => importSkill({ path: folder, scope: options.scope, origin: download.origin }, options.cwd, options.home))),
    (temp) => Effect.sync(() => rmSync(temp, { recursive: true, force: true })))
})
