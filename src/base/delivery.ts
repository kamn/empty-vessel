import { Context, Effect, Schema } from "effect"

// A small bar chart for the user (tell_user's chart): a title and up to 12 labelled numbers.
export const Chart = Schema.Struct({
  title: Schema.NonEmptyString,
  points: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.Finite }))
    .pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(12))),
})
export type Chart = typeof Chart.Type

// A chart as plain text, for a transport that can't draw one: the title, then one aligned label/value row per point.
export const chartTable = (chart: Chart): string => {
  const width = Math.max(...chart.points.map((p) => p.label.length))
  return [chart.title, ...chart.points.map((p) => `${p.label.padEnd(width)}  ${p.value}`)].join("\n")
}

// Await transport acknowledgement; a note event alone cannot confirm file delivery.
// sendChart (optional): draw the chart natively; without it (or if it fails) the chart goes as chartTable in the note.
export const Delivery = Context.Reference<{
  readonly sendFile: (path: string, caption?: string) => Effect.Effect<void, Error>
  readonly sendChart?: (chart: Chart) => Effect.Effect<void, Error>
}>("empty-vessel/Delivery", {
  defaultValue: () => ({
    sendFile: () => Effect.fail(new Error("Local file attachments are not supported by this interaction.")),
  }),
})

// Transport errors may contain authenticated URLs or Telegram bot credentials.
export const deliveryError = (error: Error): string => error.message
  .replace(/https?:\/\/[^\s]+/gi, "[redacted URL]")
  .replace(/(?:bot)?\d{5,}:[A-Za-z0-9_-]{20,}/g, "[redacted token]")
