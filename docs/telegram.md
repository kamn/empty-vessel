# Telegram channel

Telegram is another entrance to the same agent: the same model, store, memory,
and kernel, not a separate agent implementation. One process serves one allowed
private chat from one fixed working directory. Start it in the project you intend
it to edit; chat messages do not switch projects or create isolated workspaces.

The default channel remains terminal. `-p` remains terminal-only, even when
Telegram is selected. This setup does not install a daemon or background service;
the foreground process must stay running for the bot to respond.

## Create the bot and keep its token local

In Telegram, open the official @BotFather, send `/newbot`, and follow its prompts.
Open your new bot's private chat and send `/start` from the account you will allow.
Treat the returned token as a password: never paste it into an agent conversation,
issue, screenshot, repository, browser address bar, or a literal shell command.
Revoke an exposed token through BotFather and replace it locally.

Enter the token through a hidden local prompt or inject it with your secret manager.
The examples below use Bash; first start `bash` if your shell uses different syntax.
Do not enable shell tracing (`set -x`) or print your environment while handling it.

```bash
read -r -s -p 'Telegram bot token (hidden): ' EMPTY_VESSEL_TELEGRAM_TOKEN; printf '\n'
export EMPTY_VESSEL_TELEGRAM_TOKEN
```

## Find the numeric IDs locally

Stop all processes using this bot before this one-time lookup. After sending
`/start`, run this in the same Bash shell. It reads the token from the environment,
constructs the endpoint only in memory, and prints only IDs for private `/start`
messages. Do not use a third-party ID bot or paste a token-bearing URL into a browser.
Verify the result belongs to your own fresh `/start`; do not authorize a stranger's ID.

```bash
bun run - <<'JS'
try {
  const token = process.env.EMPTY_VESSEL_TELEGRAM_TOKEN;
  if (!token) throw new Error();
  const call = async (method) => {
    const endpoint = ['https://api.telegram.org', 'bot' + token, method].join('/');
    const response = await fetch(endpoint, { method: 'POST' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error();
    return data.result;
  };
  if ((await call('getWebhookInfo')).url) throw new Error();
  for (const { message: m } of await call('getUpdates')) {
    if (m?.chat?.type === 'private' && m.text === '/start' && m.from?.id)
      console.log({ allowedUserId: String(m.from.id), allowedChatId: String(m.chat.id) });
  }
} catch { console.error('Lookup failed: check token, network, webhook, and other pollers locally.'); process.exitCode = 1; }
JS
```

If no IDs appear, send `/start` again and repeat with all other pollers stopped.
The lookup does not advance the update offset; the application may see `/start`
again. It refuses a configured webhook rather than taking over another service.

## Configure and start

These are the configuration keys (IDs are **strings**, not JSON numbers):

| Config key | Environment override | Value |
| --- | --- | --- |
| `channel.use` | `EMPTY_VESSEL_CHANNEL` | `telegram` or `terminal` |
| `plugins.telegram.config.token` | `EMPTY_VESSEL_TELEGRAM_TOKEN` | BotFather token, secret |
| `plugins.telegram.config.allowedUserId` | `EMPTY_VESSEL_TELEGRAM_ALLOWED_USER_ID` | Your positive numeric user ID as a string |
| `plugins.telegram.config.allowedChatId` | `EMPTY_VESSEL_TELEGRAM_ALLOWED_CHAT_ID` | Your positive numeric private-chat ID as a string |

Prefer the environment for the token. If saving settings, use the application's
configuration writer, which already handles private file permissions. Never commit
local configuration or credentials; do not create a separate world-readable token file.
With the token already loaded through the hidden prompt, substitute your own IDs:

```bash
export EMPTY_VESSEL_TELEGRAM_ALLOWED_USER_ID='123456789'
export EMPTY_VESSEL_TELEGRAM_ALLOWED_CHAT_ID='123456789'
cd /path/to/your/project
EMPTY_VESSEL_CHANNEL=telegram empty-vessel
```

The `empty-vessel` executable must already be installed; when developing in this repository,
use `EMPTY_VESSEL_CHANNEL=telegram bun src/main.ts` from the repository root instead.

## Chat commands and sessions

| Input | Purpose |
| --- | --- |
| `/help` | Show the host's command help. |
| `/status` | Show the current session and whether work is running. |
| `/stop` | Interrupt the active turn without exiting the host. |
| `/exit` | Stop work and exit the foreground host process. |
| `/model` | Inspect or change the model using the shared model command. |
| `/refine` | Run the shared learning/refinement command. |
| `!command` | Run a shell command in the fixed cwd and share its output with the model. |
| `!!command` | Run a shell command without sharing its output with the model (still sent to your chat). |

These are host commands, not new Telegram-only model tools. The allowed account
can cause real file edits and shell execution with the host's privileges. Keep the
bot private; the allowlist is not a sandbox or an approval step.

Startup automatically resumes the persisted Telegram session when available.
CLI `--resume <session-id>` selects a session explicitly; `--continue` selects the
latest session for the project. Start from the same working directory to resume
the intended conversation. The persisted state records both the update offset and
session pointer; it is not a background daemon or a running-turn checkpoint.

To use terminal input explicitly:

```bash
EMPTY_VESSEL_CHANNEL=terminal empty-vessel
EMPTY_VESSEL_CHANNEL=terminal empty-vessel -p 'Explain this project'
```

## Delivery, recovery, and safety

- Uses long polling, not webhooks: no inbound port or public callback URL is needed.
  Startup refuses an existing webhook. Resolve that with its current owner before
  explicitly removing it; the application does not silently delete it for you.
- Both sender ID and chat ID must match the allowlist, and the chat must be private.
  Unsupported or unauthorized updates do not become agent turns.
- Run only one poller per bot, including ad hoc ID lookups. A bot-wide lock under
  the empty-vessel home prevents competing local pollers using that home. It is not a
  cross-machine lock: do not run the same bot on another host or with another home.
- The update offset is saved **before** a message is accepted for work. Acceptance
  is at-most-once within that preserved state, not guaranteed completion: a crash
  can lose a message after advancing the offset or interrupt a partly executed turn.
- After a crash or uncertain failure, review the project files, diffs, and local
  session/log state before deciding what remains. Do not automatically resend or
  replay the request. Resuming a session is not replaying unfinished work.
- Outbound sends have bounded retries. A lost acknowledgement can cause duplicate
  output messages, but sending retries never rerun the agent turn. Missing or
  duplicated chat output is not evidence that file operations did or did not run.
- State normally lives under `$EMPTY_VESSEL_HOME/telegram/state` (default
  `~/.empty-vessel/telegram/state`); locks live under the corresponding `telegram/locks`.
  State is scoped to token, chat, and canonical project directory. Preserve it;
  changing tokens, moving projects, or deleting state changes the resume identity.
- On a stale-lock error, first verify the old process and all other pollers have
  stopped. Only then remove the specific stale bot lock locally. Never delete a
  live process's lock or erase offset state just to bypass a startup error.

Keep model/provider credentials configured as usual; a Telegram token only grants
access to Telegram, not to the agent's model providers.

## Attachments

Send a photo or document in the allowed private chat, with an optional caption.
Photo-only messages also work. Captions are prompts, not host commands: a caption
starting with `!` or `/stop` does not execute a shell command or stop the host.
Only authorized private-chat media is downloaded.

Incoming files are saved under `$EMPTY_VESSEL_HOME/telegram/attachments` (default
`~/.empty-vessel/telegram/attachments`). They persist after the turn and process exit;
keep them if you want resumed sessions to retain access. Removing them manually
can leave saved session paths pointing at missing files.

Photos and supported image documents reuse the terminal's local-image/vision
path. Other documents are passed to the agent as local file paths: there is no
automatic PDF rendering, document-to-image conversion, or transcription. Incoming
attachments are limited to **20 MB**; outbound files are limited to **50 MB**.
Voice messages are unsupported, and albums are not grouped into a single prompt.

To return a generated file, the model should call
`tell_user({ message: "Here is the report", file: "/absolute/path/report.pdf" })`.
Use a local file, not a raw URL. The Telegram channel uploads the bytes with an
optional caption; file sends share ordering and throttling with text messages.

## Checks and a live smoke test

From the repository root, run the credential-free transport, wiring, and interaction tests:

```bash
bun test test/telegram.test.ts test/telegram-attachments.test.ts
bun test test/channel-wiring.test.ts test/interaction.test.ts test/inbox.test.ts
bun test test/setup.test.ts
```

These checks are not a live Telegram test. **No live Telegram credentials were
available for this documentation task; no end-to-end bot exchange was verified.**
With your own local credentials and a disposable project, manually check:

1. Start the foreground host, send `/start`, `/help`, and `/status` from the allowed
   private chat. Confirm the session is for the intended project.
2. Send a harmless question, then test question replies, `/model`, `/refine`, and
   `!pwd` / `!!pwd`. Ordinary messages during work steer the active agent.
3. Send `/stop` during a turn; inspect files rather than assuming interruption
   reversed completed edits. `/exit` should stop the host, not install a daemon.
4. Restart from the same directory and confirm automatic session continuation;
   separately check `--resume <session-id>` and `--continue` at launch.
5. Confirm another account or a group cannot start a turn. A second local poller
   should fail on the lock, and a bot with a webhook should be refused.
6. For deliberate crash/retry tests, use only disposable files. Check that an
   uncertain accepted update is not auto-replayed; tolerate duplicate send output.
7. Stop the host and run the explicit terminal commands above to check that the
   terminal path, including `-p`, still works. Unset the token when finished:
   `unset EMPTY_VESSEL_TELEGRAM_TOKEN`.
