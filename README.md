```
             @@@@@@:+@@*
          @@@+    -     ::@
        @@@      -+         @
      @@@@       -+           #
     @@@#        :.           .+        A coding agent build for transitions between models.
    @@@@         *@##          :-
   .@@@*      -*:   @@@@@       -
   #@@@:     =-       @@@@@     =       ⚠ Status: Experimental
   %@@@@     -:       @@@@@@    =
   #@@@@@     -      @@@@@@@    =.
    @@@@@@@*     :@@@@@@@@@@-  :=       
    %@@@@@@@@@@@@@@@@@@@@@@@   -
     -@@@@@@@@@@@ @@@@@@@@@  .%
       @@@@@@@@@@ @@@@@@@@  :=
         @@@@@@@@ @@@@@@   *
               #@ #
```

A coding agent build for transitions between models.
Specifically there is a System One (Jev, and Jev-like) and a System Two (Full LLM) that work together for speed, cost and learning for the next round of usage.

This is partial experimental and educational


## Install

Needs [Bun](https://bun.com) 1.3+, git and bash (macOS or Linux), and a ChatGPT account with Codex access. System Two can log in independently; installing the Codex CLI is optional.

```sh
git clone <this repo> empty-vessel && cd empty-vessel
bun install
bun link                      # puts `empty-vessel` in ~/.bun/bin, linked to this clone (git pull updates it)
```

Or build one executable (for this machine's platform), which runs without Bun or the clone:

```sh
bun run build                 # → dist/empty-vessel (about 77 MB); copy it anywhere on your PATH
```

It carries the kernel's own files (Effect, empty-vessel's built-ins, the TypeScript compiler cells are checked with) and unpacks them once per build into `~/.empty-vessel/runtime/`.

To work on empty-vessel itself, also install [gitleaks](https://github.com/gitleaks/gitleaks) (`brew install gitleaks`) for the [secret check](#secret-check).

If `empty-vessel` isn't found, add `~/.bun/bin` to your PATH (fish: `fish_add_path ~/.bun/bin`; bash/zsh: `export PATH="$HOME/.bun/bin:$PATH"`).

Then connect the two systems:

```sh
empty-vessel login codex       # once: independent ChatGPT login for System Two
empty-vessel setup                  # checks what's needed, asks for your Jev API key (https://typesafe.ai), tests it
```

`empty-vessel setup` writes `~/.empty-vessel/config.json` (only you can read it: it holds the key) and keeps any other settings there. Until it's done, empty-vessel runs both systems as fakes and says so when it starts. Every setting and its default: `src/base/config.ts`.

To change System Two later, `empty-vessel model` lists the providers (the one in use marked), lets you pick one and its model (an OpenAI-compatible server's own list; Codex's cached one), or adds an OpenAI-compatible endpoint (OpenRouter, a local server) as a copy of the openai plugin (`plugins.<name> = { "from": "openai", "config": { … } }`); its key is asked without echo and never printed. For scripts: `empty-vessel model list` and `empty-vessel model use <provider>[:<model>]`.

## Independent Codex login

```sh
empty-vessel login codex                 # browser login on this machine
empty-vessel login codex --device-code   # device code for a remote/headless terminal
empty-vessel login codex --status        # credential source and access-token expiry
empty-vessel logout codex                # local logout, not account-wide revocation
```

Login works before setup and does not require the Codex CLI. Credentials are stored in `~/.empty-vessel/providers/codex.json` (or under `EMPTY_VESSEL_HOME`), with owner-only file permissions. They are not encrypted by the OS keychain. Access tokens refresh automatically, with file locking to coordinate multiple empty-vessel processes. No credentials are printed by status.

Before your first native login, an existing `~/.codex/auth.json` remains a read-only fallback. empty-vessel never refreshes or writes that file. Native login takes precedence; broken or revoked native credentials require re-login rather than silently switching accounts. Logout writes a logged-out marker so the fallback cannot silently log you back in. It leaves Codex itself logged in.

Browser login uses a loopback callback on port 1455. If another login occupies the port, finish or cancel it, or use `--device-code`. Ctrl+C cancels login. If refresh reports a busy/orphaned credential lock after a crash, stop other empty-vessel processes before following the lock-recovery instruction; never delete an active lock.

`empty-vessel login <tool-source>` continues to handle remote tool-source OAuth; `codex` is reserved for the model login.

## Use

Resume the latest session with `empty-vessel --continue`, or choose one with
`empty-vessel --resume <session-id>` (`empty-vessel sessions` lists this folder's newest, `--all` every folder's). Add `--fork-session` to go on in a copy instead, leaving the original
session as it was (to try another direction from the same point). In the TUI, resuming restores the saved conversation
view: comments, cells and their results, expanded sections, scroll position, input history,
and unfinished drafts. The view is saved locally inside that session as you work.
Restoring the view does not rerun commands or resume an interrupted operation.

A session the always-on agent (`empty-vessel-agent`) owns is joined with `empty-vessel --attach --agent-store <store>`
(add `--agent-session <id>`; the store defaults to `EMPTY_VESSEL_AGENT_STORE`, else `./.sessions`): it shows the
conversation so far and the running turn's progress, and what you type steers it; `/stop`, `/answer`, `/retry`. A line
client, not the full TUI; see the agent's README. Under the agent, System Two can also set reminders and recurring jobs
with `schedule()` (only when you ask for one; see the agent's README).

Older sessions without a saved view are reconstructed from the available session records;
visual details that were never recorded cannot be recovered.

Point at a file with `@path` in a message (`fix the bug in @src/tools/bash.ts`): the file goes to System Two with
the request, up to 10 files and 100k characters each, with the `AGENTS.md` / `CLAUDE.md` of the folders it's in. In the
TUI, typing `@` suggests the project's files; Tab takes one (Enter sends what you typed).

Web search already works with Codex and Claude as System Two: `systemTwo.webSearch` (on by default) turns on their own
search (Codex's `web_search`, Claude Code's WebSearch and WebFetch). The `openai` plugin has no search. To let System
Two drive a browser, answer yes when `empty-vessel setup` offers one: it adds Playwright MCP as the `browser` source
(`npx @playwright/mcp@latest --isolated --headless`; needs Node's `npx`). Setup only offers it while there's no
`browser` source, so it never duplicates or overwrites one you edited.

On a Mac, `empty-vessel setup` also offers desktop control (off unless you answer yes): it adds
[macos-automator-mcp](https://github.com/steipete/macos-automator-mcp) as the `desktop` source
(`npx -y @steipete/macos-automator-mcp@latest`) with `"ask": true`, so every call asks you first (in the TUI, or in
Telegram through the agent); a turn nobody is attending (a scheduled job's, a sub-agent's) is refused at once. Any source can be marked
`"ask": true` the same way. empty-vessel must run on the Mac itself, not in Docker, and macOS needs your terminal (or the
app that runs empty-vessel) allowed under System Settings > Privacy & Security > Accessibility, and under Automation for
the apps it controls. Screenshots a source returns are shown to System Two as images.

In the TUI and in channels:

- `/undo` takes back what the last turn that changed files changed: it restores the files it edited or deleted and
  removes the ones it created. A file you changed again after that turn is kept, and so is a file the old ignore rules
  covered (e.g. a `.env` a rewritten `.gitignore` exposed). Each `/undo` goes one turn further back, also after
  `--resume`. Only in a git repo; your index and branches are not touched. It can't undo anything outside the files
  (a sent message, a remote API call). If another session worked in the same repo during that turn, `/undo` says so:
  that session's edits then count as the turn's, so check what it restored.
- `/redo` goes forward again after `/undo` (until a new turn changes files), keeping what you changed in between.
- `/compact` compacts System Two's conversation when you send your next message, whatever its size.
- `/memory` lists what empty-vessel remembers, per scope (`agent`, `project`, and the `user` profile: who you are and
  how you work, shared by every agent), numbered and with how full each is; `/memory remove <scope> <n>` forgets one
  entry. Only your own turns can write the profile, not a job's or a sub-agent's.
- `/skills` lists skills. Skills the agent saves (`saveSkill`) from a job, a sub-agent or a background review wait in
  `skills-pending/` until `/skills approve <name>` (or `/skills reject <name>`; `/skills pending` lists them); with
  `"skills": { "writeApproval": true }`, those from your own turns wait too. `/skills install <source> [--scope
  project|personal]` downloads a skill (a GitHub folder, a `SKILL.md` URL or an Agent Skills index entry, HTTPS only),
  shows every file and what the scan flagged, and installs only when you answer Install; nothing in it runs.
  `/skills browse <index-url>` lists what an index offers.

Memory nudges (`"nudges": true`, the default): after 10 of your turns (or 10 tool calls) that showed something to learn,
such as a correction, a steer or failing checks, a background review may save, update or remove memory entries.

System Two can look back at earlier sessions with `pastSessions` in a cell: `pastSessions("words")` searches this
project's sessions (`allProjects: true` for every project's, `summarize: true` adds a summary), `{ mode: "scroll",
session, seq }` shows the messages around a hit and `{ mode: "read", session }` a whole session.

A TUI turn that takes 30 seconds or more ends with a desktop notification (OSC 9: iTerm2, Ghostty, WezTerm and others).

## Terminal theme

Add `"theme": "teal"` alongside your existing settings in `~/.empty-vessel/config.json`,
then restart empty-vessel. Available themes: `orange` (default), `blue`, `green`, and `teal`.
The palette changes TUI accents, activity, inline code, code numbers, and the startup logo;
errors remain red. The default orange theme retains the rotating logo palettes.

The TUI renders Markdown web links and absolute `file://` links as clickable terminal
links. Percent-encode spaces in file URLs. Opening links requires terminal support.

## ActionGuard

Optional shell-execution policy: allow, deny, request a revision, or ask for human approval.
Kernel workers ask the host before execution; no guard is enabled by default.
The bundled `no-absolute-rm` policy blocks explicit absolute deletion targets such as `rm -rf /tmp/folder`.
Preview without execution: `bun src/main.ts guard --policy no-absolute-rm --command 'rm -rf /tmp/folder'`.
The bundled `jev-guard` also accepts a policy prompt and requires confident Jev approval.
See [ActionGuard configuration and limits](docs/action-guard.md).

## Secret check

A pre-commit hook (`.githooks/pre-commit`) runs [gitleaks](https://github.com/gitleaks/gitleaks) on the staged changes
and refuses a commit that contains a secret: an API key, a token, a private key. The secret is shown redacted.

- `bun install` turns it on (package.json's `prepare`: `git config core.hooksPath .githooks`). It needs gitleaks
  (`brew install gitleaks`); without it, every commit is refused and says so.
- A false positive: add the fingerprint gitleaks prints (`file:rule:line`) to a `.gitleaksignore` file.
- `git commit --no-verify` skips the check. Don't, unless you've looked at what's staged.
- To check the whole history: `gitleaks git .`

## Credits

- **System Two's default response style** is the [i-have-adhd](https://github.com/ayghri/i-have-adhd) skill by
  Ayoub Ghriss (MIT License): lead with the next action, numbered steps, specific time estimates, no preamble or
  closing pleasantries. The skill is included unchanged in `src/system-two/styles/i-have-adhd.md`, with its license
  beside it (`i-have-adhd.LICENSE`). Turn it off with `"systemTwo": { "style": "none" }` in `~/.empty-vessel/config.json`.
