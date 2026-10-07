import { Schema } from "effect"
import { described, setting } from "empty-vessel"

// The OpenAI-compatible System Two's settings (config.json: plugins.openai.config; or EMPTY_VESSEL_OPENAI_API_KEY and the
// like for one run). The key is Redacted, and optional: a local server may not need one.
export const DEFAULT_BASE_URL = "https://api.openai.com/v1"
export const settings = described({
  baseUrl: setting(Schema.String, "The API's address, up to /v1 (a local server's too)", { default: DEFAULT_BASE_URL }),
  model: setting(Schema.String, "The model System Two uses"),
  fillModel: setting(Schema.String, "A smaller model for filling in tool arguments; the main one if absent", { optional: true }),
  apiKey: setting(Schema.RedactedFromValue(Schema.String), "The API key; a local server may need none", { optional: true }),
})
