import { Effect } from "effect"
import { importSkill } from "../base/skill-import"
import { parseSkillImport, type ImportRoute } from "./skill-import-command"
import { discoverSkills, listSkills, loadSkill } from "../base/skills"
import type { SessionHandle } from "../base/session"
import type { Conversation } from "./turnkit"

// Reserve host commands too: a skill cannot change a command's meaning between UIs.
export const skillReservedCommands = new Set([
  "skills", "skill", "model", "agent", "refine", "review", "memory", "flag",
  "help", "start", "status", "stop", "exit",
])
export type SkillRoute =
  | ImportRoute
  | { readonly kind: "list" | "reload" }
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
    if (rest === "reload") return { kind: "reload" }
    if (/^import(?:\s|$)/.test(rest)) return parseSkillImport(rest.slice("import".length))
    return { kind: "error", message: "Usage: /skills [reload] or /skills import <folder> --scope project|personal" }
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
export const skillCommand = (session: SessionHandle, conversation: Conversation, input: string, cwd = process.cwd(), home?: string) => Effect.gen(function* () {
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
  if (route.kind === "import") {
    const imported = yield* importSkill({ path: route.path, scope: route.scope }, cwd, home)
    conversation.skills = discoverSkills(cwd, home)
    conversation.skillCatalogPending = true
    const selected = conversation.skills.skills.find(skill => skill.name === imported.name)
    const status = !selected ? "Not present in the refreshed catalog; run /skills to inspect diagnostics."
      : selected.directory !== imported.destination ? `An installed ${selected.source} skill with this name takes precedence: ${selected.path}`
      : "Available now; no reload needed."
    return { kind: "reply", reply: `Imported ${imported.name} to ${imported.destination}.\nProvenance: ${imported.provenance}\n${status}` } as const
  }
  if (route.kind !== "invoke") return undefined
  const content = yield* loadSkill(catalog, { name: route.name, arguments: route.arguments }, "user")
  yield* session.record("skill", route.name, { content })
  conversation.activeSkills ??= {}
  Object.defineProperty(conversation.activeSkills, route.name, { value: content, writable: true, enumerable: true, configurable: true })
  conversation.explicitSkill = true
  return { kind: "activation", content } as const
})
