import { Schema } from "effect"
import { described, setting } from "empty-vessel"

// Jev's settings (config.json: plugins.jev.config; or EMPTY_VESSEL_JEV_API_KEY for one run). The key is Redacted: it
// prints as <redacted>, so it can't end up in a log or an error.
export const settings = described({
  apiKey: setting(Schema.RedactedFromValue(Schema.String), "Your Jev API key, from TypeSafe AI"),
})
