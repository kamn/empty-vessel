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

Needs [Bun](https://bun.com) 1.3+, git and bash (macOS or Linux), and the [Codex CLI](https://github.com/openai/codex) logged in (`codex login`): System Two runs on your ChatGPT plan through it.

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
codex login                   # once: System Two runs on your ChatGPT plan through the Codex CLI
empty-vessel setup                  # checks what's needed, asks for your Jev API key (https://typesafe.ai), tests it
```

`empty-vessel setup` writes `~/.empty-vessel/config.json` (only you can read it: it holds the key) and keeps any other settings there. Until it's done, empty-vessel runs both systems as fakes and says so when it starts. Every setting and its default: `src/base/config.ts`.

## Use

Resume the latest session with `empty-vessel --continue`, or choose one with
`empty-vessel --resume <session-id>`. In the TUI, resuming restores the saved conversation
view: comments, cells and their results, expanded sections, scroll position, input history,
and unfinished drafts. The view is saved locally inside that session as you work.
Restoring the view does not rerun commands or resume an interrupted operation.

Older sessions without a saved view are reconstructed from the available session records;
visual details that were never recorded cannot be recovered.

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
