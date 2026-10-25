import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { described, setting } from "empty-vessel"

// Codex's settings (config.json: plugins.codex.config; or EMPTY_VESSEL_CODEX_MODEL and the like for one run).
export const settings = described({
  model: setting(Schema.String, "The model System Two uses on your ChatGPT plan (the ones there are: ~/.codex/models_cache.json)", { default: "gpt-6-luna" }),
  fillModel: setting(Schema.String, "The small model for filling in tool arguments", { default: "gpt-6-luna" }),
})

// The models the Codex CLI last saw on your plan (~/.codex/models_cache.json, or $CODEX_HOME's), if it's there: none
// otherwise, and then the model is typed. Hidden ones (reviewers, reserves) left out.
export const cachedModels = (home = process.env.CODEX_HOME || join(homedir(), ".codex")): ReadonlyArray<string> => {
  try {
    const { models } = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8")) as { models?: Array<{ slug?: string; visibility?: string }> }
    return (models ?? []).flatMap((m) => (m.slug && m.visibility !== "hide" ? [m.slug] : []))
  } catch { return [] }
}
