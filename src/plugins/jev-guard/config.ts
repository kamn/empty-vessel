import { Schema } from "effect"
import { described, setting } from "empty-vessel"

export const settings = described({
  prompt: setting(Schema.String, "Trusted action approval policy; must contain non-whitespace text"),
})
