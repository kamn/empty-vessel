import { Schema } from "effect"
import { described, setting } from "empty-vessel"

// Claude's settings (config.json: plugins.claude.config; or EMPTY_VESSEL_CLAUDE_MODEL and the like for one run).
export const settings = described({
  model: setting(Schema.String, "The model claude -p uses (e.g. opus, or a full model id); none: Claude Code's default", { optional: true }),
  fillModel: setting(Schema.String, "The small model for filling in tool arguments and judge's re-checks", { default: "haiku" }),
})
