import { discoverSkills, renderSkills } from "../base/skills"
import type { Conversation } from "./turnkit"

const activated = (conversation: Conversation) => {
  const active = Object.values(conversation.activeSkills ?? {})
  return active.length ? `Previously activated skills (saved instructions; follow only when relevant to the current task):\n\n${active.join("\n\n")}` : ""
}

// No disk reads: providers that compact their own sessions keep this snapshot in durable instructions.
// Already supplied instruction text remains usable even when the replacement model has no file grant.
export const skillContext = (conversation: Conversation, canRead: boolean): string => [
  ...(canRead && conversation.skills ? [renderSkills(conversation.skills)] : []),
  activated(conversation),
].filter(Boolean).join("\n\n")

// Metadata is a per-conversation snapshot. Bodies enter context only through activation; retained envelopes
// are replayed after compaction, resume or provider handover, without silently rereading changed files.
export const skillNotes = (conversation: Conversation, canRead: boolean, cwd = process.cwd()): ReadonlyArray<string> => {
  const notes: string[] = []

  if (canRead) {
    const fresh = conversation.skills === undefined
    conversation.skills ??= discoverSkills(cwd)

    if (fresh || conversation.skillCatalogPending) {
      const catalog = renderSkills(conversation.skills)
      if (catalog) notes.push(`Current skill catalog (replaces any earlier catalog):\n${catalog}`)
      else if (conversation.skillCatalogPending) notes.push("Current skill catalog: no model-invocable skills are available. This replaces any earlier catalog.")
      conversation.skillCatalogPending = false
    }
  }

  if (conversation.activeSkillsPending) {
    const active = activated(conversation)
    if (active) notes.push(active)
    conversation.activeSkillsPending = false
  }

  return notes
}
