import { Redacted, Schema } from "effect"
import { described, setting } from "empty-vessel"

export const positiveId = Schema.String.pipe(Schema.check(
  Schema.isPattern(/^[1-9]\d*$/),
  Schema.makeFilter((id: string) => Number.isSafeInteger(Number(id)) || "Expected a safely representable Telegram ID"),
))
// Validate after wrapping, so diagnostics never print a malformed secret.
const token = Schema.RedactedFromValue(Schema.String).pipe(Schema.check(
  Schema.makeFilter((value: Redacted.Redacted<string>) => /^\d+:[A-Za-z0-9_-]+$/.test(Redacted.value(value)) || "Expected a BotFather token (redacted)"),
))
const stateDirectory = Schema.String.pipe(Schema.check(
  Schema.makeFilter((value: string) => value.trim().length > 0 || "Expected a non-empty state directory"),
))
export const settings = described({
  token: setting(token, "Bot token from BotFather"),
  allowedUserId: setting(positiveId, "Authorized Telegram sender ID (positive digit string)"),
  allowedChatId: setting(positiveId, "Authorized private chat ID (positive digit string)"),
  stateDirectory: setting(stateDirectory, "State directory; defaults to $EMPTY_VESSEL_HOME/telegram/state or ~/.empty-vessel/telegram/state", { optional: true }),
})
