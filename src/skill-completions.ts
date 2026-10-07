import type { SkillCatalog } from "./base/skills"
import { skillReservedCommands } from "./loop/skill-commands"
import type { Completion } from "./ui/tui/completion"

// Only commands that the TUI or shared session runner handles belong in this menu.
export const builtinCompletions: ReadonlyArray<Completion> = [
  { command: "/skills", description: "List installed skills and diagnostics" },
  { command: "/skills reload", description: "Refresh skills after creating or editing a skill" },
  { command: "/skills import", description: "Import a local folder: <folder> --scope project|personal" },
  { command: "/skill", description: "Choose a skill by name (also for command-name conflicts)" },
  { command: "/model", description: "Show or change the model" },
  { command: "/agent", description: "Show or change the agent" },
  { command: "/refine", description: "Review sessions for reusable improvements" },
  { command: "/review", description: "Review project sessions" },
  { command: "/flag", description: "Mark this moment with a note" },
  { command: "/exit", description: "Exit the TUI" },
]

// Discovery already resolved project precedence. Only metadata is used: never load bodies or assets for a menu.
export const skillCompletions = (catalog: SkillCatalog): ReadonlyArray<Completion> => [
  ...builtinCompletions,
  ...catalog.skills.filter(skill => skill.userInvocable && skill.unsupported.length === 0).map(skill => ({
    skillName: skill.name,
    command: skillReservedCommands.has(skill.name) ? `/skill ${skill.name}` : `/${skill.name}`,
    description: skill.description.replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ").trim(),
  })),
]
