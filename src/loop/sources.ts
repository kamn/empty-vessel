import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { type Config, readConfigFile, writeConfigFile } from "../base/config"
import { EMPTY_VESSEL_HOME } from "../base/home"
import type { SourceTool, ToolSource } from "../kernel/kernel"
import { localSource, remoteSource } from "../kernel/mcp"
import { type Login, login, refresh } from "../kernel/oauth"

// empty-vessel's tool sources: the config's `sources`, made once per process and shared by
// every kernel (System Two's, System One's, promote's check, adoption's, sub-agents'), so each server's connection and tool
// list are made once. Logins (OAuth tokens) live in ~/.empty-vessel/auth/<name>.json, readable only by the user.

type Sources = Config["Service"]["sources"]
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

const authFile = (name: string, home = EMPTY_VESSEL_HOME) => join(home, "auth", `${name}.json`)
export const loadLogin = (name: string, home = EMPTY_VESSEL_HOME): Login | undefined => {
  try { return JSON.parse(readFileSync(authFile(name, home), "utf8")) } catch { return undefined }
}
export const saveLogin = (name: string, l: Login, home = EMPTY_VESSEL_HOME) => {
  mkdirSync(join(home, "auth"), { recursive: true, mode: 0o700 })
  writeFileSync(authFile(name, home), JSON.stringify(l), { mode: 0o600 })
  chmodSync(authFile(name, home), 0o600)
}

// The sources from the config. A remote one with "auth": "oauth" sends its saved login's token and refreshes it after a
// 401 (or says to log in again); names that aren't TypeScript names are left out (cells import them by name).
export const makeSources = (config: Sources, home = EMPTY_VESSEL_HOME) =>
  Object.entries(config).filter(([name]) => NAME.test(name)).flatMap(([name, c]): Array<ToolSource & { close?: () => void }> => {
    if (c.command) return [localSource({ name, command: c.command, ...(c.args ? { args: c.args } : {}), ...(c.env ? { env: c.env } : {}) })]
    if (!c.url) return []
    const oauth = c.auth === "oauth"
    return [remoteSource({
      name, url: c.url,
      headers: async () => {
        const saved = oauth ? loadLogin(name, home) : undefined
        if (oauth && !saved) throw new Error(`${name}: not logged in: run empty-vessel login ${name}`)
        return { ...c.headers, ...(saved ? { authorization: `Bearer ${saved.accessToken}` } : {}) }
      },
      ...(oauth ? { unauthorized: async () => {
        const saved = loadLogin(name, home)
        if (!saved) throw new Error(`${name}: not logged in: run empty-vessel login ${name}`)
        saveLogin(name, await refresh(saved).catch(() => { throw new Error(`${name}: the login has expired: run empty-vessel login ${name}`) }), home)
      } } : {}),
    })]
  })

// The process's sources: set once at startup (main.ts), read by every kernel. ponytail: a module-level list; pass it
// through the loop's context if more than one set of sources is ever needed in a process.
let active: ReadonlyArray<ToolSource & { close?: () => void }> = []
export const useSources = (sources: typeof active) => { active = sources }
export const kernelSources = (): ReadonlyArray<ToolSource> => active
export const closeSources = () => { for (const s of active) s.close?.() }

// For System Two's prompt: each source and its tools' names (listing a source that can't be reached says why), then
// what each source says about using it (an MCP server's instructions: its command syntax, what it's for).
// ponytail: instructions are cut at 4000 characters each; summarise them with System One if servers send much more.
const MAX_INSTRUCTIONS = 4000
export const sourcesLine = Effect.gen(function* () {
  if (!active.length) return ""
  const parts = yield* Effect.forEach(active, (s) => s.list.pipe(
    Effect.map((tools) => `${s.name} (${tools.map((t) => t.name.replace(/[^A-Za-z0-9_$]/g, "_")).join(", ")})`),
    Effect.catch((e) => Effect.succeed(`${s.name} (not available: ${e.message})`)),
  ), { concurrency: "unbounded" })

  const told = active.flatMap((s) => {
    const text = s.instructions?.()?.trim()
    return text ? [`${s.name}'s instructions (from the source itself):\n${text.length > MAX_INSTRUCTIONS ? `${text.slice(0, MAX_INSTRUCTIONS)}…` : text}`] : []
  })

  return [`Tool sources (outside tools, import from "kernel"; each tool takes one object of arguments; tools() describes them): ${parts.join("; ")}`, ...told].join("\n\n")
})

// For tools(): each source tool's description and arguments.
export const sourceTools = Effect.gen(function* () {
  const lists = yield* Effect.forEach(active, (s) => s.list.pipe(Effect.orElseSucceed((): ReadonlyArray<SourceTool> => []), Effect.map((tools) => ({ s, tools }))))
  return Object.fromEntries(lists.flatMap(({ s, tools }) => tools.map((t) => [`${s.name}.${t.name.replace(/[^A-Za-z0-9_$]/g, "_")}`, `${t.description}${t.inputSchema ? ` Arguments: ${JSON.stringify((t.inputSchema as { properties?: object }).properties ?? {})}` : ""}`])))
})

// `empty-vessel login <name>`: the browser opens on the login page; the login is saved when it redirects back.
export const loginTo = (name: string, config: Sources, home = EMPTY_VESSEL_HOME) =>
  Effect.tryPromise({
    try: async () => {
      const c = config[name]
      if (!c?.url) throw new Error(`no remote source named ${name} in the config's sources`)
      const saved = await login(c.url, (url) => {
        console.log(`Opening your browser to log in to ${name}. If it doesn't open, go to:\n${url}`)
        Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" })
      })
      saveLogin(name, saved, home)
      return `Logged in to ${name}.`
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })

// Changing the config's sources from the command line (`empty-vessel sources add | list | remove`), so nobody has to edit
// the JSON. The rest of the file (the Jev key…) is kept as it is and never printed; the file stays readable only by
// the user, and is replaced whole (a temp file renamed over it).
type Entry = Sources[string]
const readConfig = readConfigFile, writeConfig = writeConfigFile

// A source from what's given on the command line: a URL is a remote server, anything else a local command (and its
// arguments, split on spaces).
export const entryFor = (target: string, options: { oauth?: boolean; headers?: Record<string, string> } = {}): Entry =>
  /^https?:\/\//.test(target)
    ? { url: target, ...(options.oauth ? { auth: "oauth" as const } : {}), ...(options.headers && Object.keys(options.headers).length ? { headers: options.headers } : {}) }
    : (([command, ...args]) => ({ command: command!, ...(args.length ? { args } : {}) }))(target.split(/\s+/).filter(Boolean))

export const addSource = (file: string, name: string, entry: Entry) => {
  if (!NAME.test(name)) throw new Error(`"${name}" can't be a source name: cells import it by name (letters, digits, _)`)
  const config = readConfig(file)
  writeConfig(file, { ...config, sources: { ...(config.sources as object | undefined), [name]: entry } })
}

export const removeSource = (file: string, name: string, home = EMPTY_VESSEL_HOME) => {
  const config = readConfig(file)
  const sources = { ...(config.sources as Record<string, unknown> | undefined) }
  if (!(name in sources)) return false
  delete sources[name]
  writeConfig(file, { ...config, sources })
  rmSync(authFile(name, home), { force: true }) // its login too
  return true
}

// One line per source: where it is and how it logs in; header names only, never their values.
export const describeSources = (config: Sources, home = EMPTY_VESSEL_HOME) =>
  Object.entries(config).map(([name, c]) =>
    c.url
      ? `${name}  ${c.url}${c.auth === "oauth" ? `  oauth (${loadLogin(name, home) ? "logged in" : `not logged in: empty-vessel login ${name}`})` : ""}${c.headers ? `  headers: ${Object.keys(c.headers).join(", ")}` : ""}`
      : `${name}  local: ${[c.command, ...(c.args ?? [])].join(" ")}`)
