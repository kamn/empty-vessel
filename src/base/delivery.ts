import { Context, Effect } from "effect"

// Await transport acknowledgement; a note event alone cannot confirm file delivery.
export const Delivery = Context.Reference<{
  readonly sendFile: (path: string, caption?: string) => Effect.Effect<void, Error>
}>("empty-vessel/Delivery", {
  defaultValue: () => ({
    sendFile: () => Effect.fail(new Error("Local file attachments are not supported by this interaction.")),
  }),
})

// Transport errors may contain authenticated URLs or Telegram bot credentials.
export const deliveryError = (error: Error): string => error.message
  .replace(/https?:\/\/[^\s]+/gi, "[redacted URL]")
  .replace(/(?:bot)?\d{5,}:[A-Za-z0-9_-]{20,}/g, "[redacted token]")
