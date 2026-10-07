# Telegram transport

Public plugin export: `telegram` from `src/plugins/telegram/index.ts`.
It provides `channel`; registration and the host runner are intentionally outside this plugin.
Additional exports: `telegramLayer`, `makeTelegramChannel`, `TelegramOptions`, `TelegramDependencies`.

Settings under `plugins.telegram.config`:
- `token`: Redacted bot token; `EMPTY_VESSEL_TELEGRAM_TOKEN` overrides it.
- `allowedUserId`: positive digit string; `EMPTY_VESSEL_TELEGRAM_ALLOWED_USER_ID`.
- `allowedChatId`: positive private-chat digit string; `EMPTY_VESSEL_TELEGRAM_ALLOWED_CHAT_ID`.
- `stateDirectory`: optional; `EMPTY_VESSEL_TELEGRAM_STATE_DIRECTORY`.

State defaults to `$EMPTY_VESSEL_HOME/telegram/state`, or `~/.empty-vessel/telegram/state`.
Files are keyed by token hash, chat ID and canonical project working-directory path.
Directories use mode 0700; atomic, fsynced state replacements use mode 0600.
Offsets and session IDs share a file. Corrupt state fails closed instead of resetting offsets.

**At-most-once crash tradeoff:** each offset is saved before the host callback. A crash between
that save and execution can lose a message. Uncertain executions are never automatically replayed.
The host callback must enqueue promptly, not wait for an agent turn. Sending and polling have separate gates.
Outbound transient failures are retried independently (four attempts total); an ambiguous network failure
may duplicate a sent reply. Retries respect `retry_after`, but a delay over 60 seconds fails rather than retrying early.

Bot-wide locks live under the same empty-vessel home's `telegram/locks/<bot-id>`, independent of project,
chat, token rotation and custom state directory. Normal scope exit releases them. A hard crash leaves a
lock: verify the old process stopped before removing it manually. Different homes or machines cannot
coordinate these local locks; do not run the same bot there concurrently. Existing webhooks are rejected,
never deleted. Startup uses getMe and getWebhookInfo; no remote mutation is needed for validation.

Cell progress appends summaries (not code or output) to one quiet message, continuing in a new
message when full. Consecutive identical summaries are skipped. Notes, questions and final replies
are permanent messages; the next progress update starts fresh. Updates share the normal send rate limit.

Authorized photos and documents are downloaded under `$EMPTY_VESSEL_HOME/telegram/attachments`.
Their local paths enter the shared agent input flow; supported images use the same image handling
as the TUI. Captions remain prompts rather than host commands. Files persist for session resume.
Incoming files are limited to 20 MB; failures are reported without dispatching a partial attachment.
`sendFile` uploads local files as documents (up to 50 MB), sharing the outbound send gate and throttle.
Model-facing delivery uses `tell_user` with a `file` path; merely mentioning a path does not upload it.

Tests inject HTTP; no real bot credentials or live Telegram requests are used.
