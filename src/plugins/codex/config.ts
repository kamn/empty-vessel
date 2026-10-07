import { Schema } from "effect"
import { described, setting } from "empty-vessel"

// Codex's settings (config.json: plugins.codex.config; or EMPTY_VESSEL_CODEX_MODEL and the like for one run).
export const settings = described({
  model: setting(Schema.String, "The model System Two uses on your ChatGPT plan (the ones there are: ~/.codex/models_cache.json)", { default: "gpt-6-luna" }),
  fillModel: setting(Schema.String, "The small model for filling in tool arguments", { default: "gpt-6-luna" }),
})
