import { Effect, Option } from "effect"
import { type Confirm, type Http, installSkill, readIndex } from "../base/skill-hub"
import { importSkill } from "../base/skill-import"
import { parseSkillImport, type ImportRoute } from "./skill-import-command"
import { approveSkill, discoverSkills, listSkills, loadSkill, pendingSkills, rejectSkill } from "../base/skills"
import { EMPTY_VESSEL_HOME } from "../base/home"
import type { SessionHandle } from "../base/session"
import type { Conversation } from "./turnkit"
import { AskUser } from "../ui/ask"

// Reserve host commands too: a skill cannot change a command's meaning between UIs.
export const skillReservedCommands = new Set([
  "skills", "skill", "model", "agent", "refine", "review", "memory", "flag", "undo", "redo", "compact",
  "help", "start", "status", "stop", "exit",
])
export type SkillRoute =
  | ImportRoute
  | { readonly kind: "list" | "reload" | "pending" }
  | { readonly kind: "approve" | "reject"; readonly name: string }
  | { readonly kind: "install"; readonly source: string; readonly scope: "project" | "personal" }
  | { readonly kind: "browse"; readonly source: string }
  | { readonly kind: "invoke"; readonly name: string; readonly arguments?: string }
  | { readonly kind: "error"; readonly message: string }

// Unknown shorthand is deliberately not ours. Explicit /skill is always ours.
export const routeSkillCommand = (input: string, names: Iterable<string>): SkillRoute | undefined => {
  const match = input.match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
  if (!match) return undefined
  const command = match[1]!
  const rest = (match[2] ?? "").trim()
  if (command === "skills") {
    if (!rest) return { kind: "list" }
    if (rest === "reload" || rest === "pending") return { kind: rest }
    const decision = rest.match(/^(approve|reject)\s+(\S+)$/)
    if (decision) return { kind: decision[1] as "approve" | "reject", name: decision[2]! }
    if (/^import(?:\s|$)/.test(rest)) return parseSkillImport(rest.slice("import".length))
    const install = rest.match(/^install\s+(\S+)(?:\s+--scope(?:\s+|=)(project|personal))?$/)
    if (install) return { kind: "install", source: install[1]!, scope: (install[2] ?? "personal") as "project" | "personal" }
    const browse = rest.match(/^browse\s+(\S+)$/)
    if (browse) return { kind: "browse", source: browse[1]! }
    return { kind: "error", message: "Usage: /skills [reload | pending | approve <name> | reject <name>], /skills import <folder> --scope project|personal, /skills install <source> [--scope project|personal] or /skills browse <index-url>" }
  }
  if (command === "skill") {
    const invocation = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/)
    if (!invocation) return { kind: "error", message: "Usage: /skill <name> [arguments]" }
    return { kind: "invoke", name: invocation[1]!, ...(invocation[2] ? { arguments: invocation[2] } : {}) }
  }
  if (skillReservedCommands.has(command) || !new Set(names).has(command)) return undefined
  return { kind: "invoke", name: command, ...(rest ? { arguments: rest } : {}) }
}

export type SkillCommandResult =
  | { readonly kind: "reply"; readonly reply: string }
  | { readonly kind: "activation"; readonly content: string }

// This runs on the host, never inside the model's kernel. Only the native registry
// resolves names/paths and checks invocation permissions; arguments are plain text.
// The install confirm: the file list and its flags; a typed file path shows that file and asks again.
const confirmWith = (user: AskUser["Service"]): Confirm => (summary, files) => Effect.gen(function* () {
  const ask = `Install this skill? Nothing in it runs on its own. Type a file's path to read it.\n${summary}`
  let question = ask

  for (;;) {
    const [answer] = yield* user.ask([{ question, options: ["Install", "Cancel"] }])
    const said = answer?.answer.trim()
    if (said === "Install") return true
    const file = files.find((f) => f.path === said)
    if (!file) return false
    question = `${file.path}:\n${file.bytes.toString("utf8").slice(0, 16_000)}\n\n${ask}`
  }
})

// The import and install reply: where it went, and whether the refreshed catalog uses it.
const installed = (conversation: Conversation, done: { name: string; destination: string; provenance: string }, verb: string, cwd: string, home?: string) => {
  conversation.skills = discoverSkills(cwd, home)
  conversation.skillCatalogPending = true
  const selected = conversation.skills.skills.find(skill => skill.name === done.name)
  const status = !selected ? "Not present in the refreshed catalog; run /skills to inspect diagnostics."
    : selected.directory !== done.destination ? `An installed ${selected.source} skill with this name takes precedence: ${selected.path}`
    : "Available now; no reload needed."
  return { kind: "reply", reply: `${verb} ${done.name} to ${done.destination}.\nProvenance: ${done.provenance}\n${status}` } as const
}

// `http`: the hub's fetch (install, browse), a fake in tests.
export const skillCommand = (session: SessionHandle, conversation: Conversation, input: string, cwd = process.cwd(), home?: string, http: Http = fetch) => Effect.gen(function* () {
  if (!input.startsWith("/")) return undefined
  const catalog = conversation.skills ?? discoverSkills(cwd, home)
  const route = routeSkillCommand(input, catalog.skills.map(skill => skill.name))
  if (!route) return undefined
  conversation.explicitSkill = false
  if (!conversation.skills) conversation.skillCatalogPending = true
  conversation.skills = catalog
  if (route.kind === "error") return yield* Effect.fail(route.message)
  if (route.kind === "list") return { kind: "reply", reply: listSkills(catalog) } as const
  if (route.kind === "reload") {
    conversation.skills = discoverSkills(cwd, home)
    conversation.skillCatalogPending = true
    return { kind: "reply", reply: listSkills(conversation.skills) } as const
  }
  // Skills the agent saved for approval (KTD20): approved ones join the catalog at once.
  if (route.kind === "pending") return { kind: "reply", reply: pendingSkills(home) } as const
  if (route.kind === "reject") {
    yield* rejectSkill(route.name, home)
    return { kind: "reply", reply: `Rejected ${route.name}: the staged skill is deleted.` } as const
  }
  if (route.kind === "approve") {
    const saved = yield* approveSkill(route.name, { cwd, home })
    conversation.skills = discoverSkills(cwd, home)
    conversation.skillCatalogPending = true
    return { kind: "reply", reply: `Approved ${saved.name}: ${saved.path}. Available now.` } as const
  }
  if (route.kind === "import") return installed(conversation, yield* importSkill({ path: route.path, scope: route.scope }, cwd, home), "Imported", cwd, home)

  // Downloads on the host (KTD22); the user sees every file and its flags and says yes, or nothing installs.
  if (route.kind === "install") {
    const user = yield* Effect.serviceOption(AskUser)
    if (Option.isNone(user)) return yield* Effect.fail(`Installing a skill needs you to confirm it, and there's no one to ask here.`)
    const done = yield* installSkill(route.source, { scope: route.scope, cwd, home: home ?? EMPTY_VESSEL_HOME, http, confirm: confirmWith(user.value) })
    if (!done) return { kind: "reply", reply: "Not installed." } as const
    return installed(conversation, done, "Installed", cwd, home)
  }

  if (route.kind === "browse") {
    const { url, entries } = yield* readIndex(http, route.source)
    const lines = entries.map((e) => e.type === "skill-md" ? `${e.name} — ${e.description}\n  /skills install ${url}#${e.name}` : `${e.name} — ${e.description} (${e.type}: not supported yet)`)
    return { kind: "reply", reply: entries.length ? `Skills at ${url}:\n${lines.join("\n")}` : `No skills listed at ${url}.` } as const
  }

  if (route.kind !== "invoke") return undefined
  const content = yield* loadSkill(catalog, { name: route.name, arguments: route.arguments }, "user")
  yield* session.record("skill", route.name, { content })
  conversation.activeSkills ??= {}
  Object.defineProperty(conversation.activeSkills, route.name, { value: content, writable: true, enumerable: true, configurable: true })
  conversation.explicitSkill = true
  return { kind: "activation", content } as const
})
