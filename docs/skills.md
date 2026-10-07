# Skills

Create `.empty-vessel/skills/explain/SKILL.md` in your project, then send `/skills reload`.

```markdown
---
name: explain
description: Explain a part of this project with examples and file references.
---
Explain $ARGUMENTS. Read the relevant source first. Use a small example and
point out assumptions. Do not change files unless the user asks.
```

Invoke it in the plain CLI or TUI with either command:

```text
/explain the session runner
/skill explain the session runner
```

## Finding commands in the TUI

Type `/` while idle to open command suggestions, including `/skills`, reload/import,
and your installed skills. Type more to filter; descriptions explain each entry.
Use Up/Down to select and Tab to fill the input without sending it. Enter fills a
partial match; press Enter again to send. An exact command such as `/skills` sends
immediately. Escape dismisses the menu without clearing your draft.

Type `/skill ` to choose a skill by name, including names that collide with built-in
commands. User-disabled and unsupported-metadata skills are not suggested; inspect
`/skills` for diagnostics. Imports and `/skills reload` refresh the menu automatically.
No skill bodies are read for suggestions. The menu stays out of the way during a
running turn or an interactive question.

## Commands

| Command | Result |
| --- | --- |
| `/skills` | List discovered names, descriptions, paths, invocation permissions and diagnostics. No model turn. |
| `/skills reload` | Rescan native roots and mark the catalog for the model's next briefing update. No model turn. |
| `/skills import <folder> --scope <scope>` | Validate and copy a local package, preserve its source, and refresh discovery. No model turn. |
| `/skill <name> [arguments]` | Explicitly activate a named skill. Missing, unknown or disabled names fail with an error. |
| `/<name> [arguments]` | Shorthand for a discovered skill, unless the name belongs to a built-in command. |

Built-ins always win: `skills`, `skill`, `model`, `agent`, `refine`, `review`,
`memory`, `flag`, `help`, `start`, `status`, `stop` and `exit` are reserved.
For a skill named `review`, use `/skill review ...`, not `/review ...`.
Unknown slash commands are left to the normal host/turn handling; they are not
reported as unknown skills unless you use `/skill` explicitly.

Send invocation commands when the host is idle. Messages typed during active
work may be treated as steering or question replies by the channel/TUI rather
than as a new command.

## Import a local skill folder

```text
/skills import "/path/to/my skill" --scope project
/skills import ~/Downloads/my-skill --scope personal
```

The source must be one folder containing `SKILL.md`, not a parent folder holding
several skills. Relative paths resolve from the current working directory; `~/`
uses your operating-system home. Quote paths containing spaces. Scope is required:
`project` installs at the current Git worktree's root (or the current directory
outside Git), and `personal` uses the configured empty-vessel home.

Importing validates the package, copies the whole folder under its declared skill
name (or source-folder name when omitted), and refreshes discovery immediately.
It does not activate the skill or make a model call. Scripts, references, assets,
file bytes and executable permission bits are copied; the source is left untouched.
Variables, globs and command substitutions in the path are not evaluated.

Imports refuse:

- Existing destinations or the same declared name already installed in that scope.
  There is no overwrite/update flag; project-over-personal precedence still applies.
- Invalid metadata, unsupported features, dynamic command injection, or a missing
  `SKILL.md`. Validation errors explain what needs changing; nothing is silently stripped.
- Symlinks, nonregular entries such as FIFOs, or a destination inside the source.
- Packages over 1,024 entries or 64 MiB total, in addition to the loader's `SKILL.md`
  limits. A source containing the reserved `.empty-vessel-import.json` file is rejected.

The installed `.empty-vessel-import.json` receipt records the canonical source path,
import timestamp, scope and SHA-256 hashes of copied files. It contains a local path;
review it before sharing the installed package publicly.

No imported code runs during validation or copying. Compatibility validation is not
a security audit: inspect unfamiliar instructions and scripts before activating them.
On an ordinary copy failure, the newly created destination is removed. A process
crash can leave an incomplete folder; inspect it before manually removing it and retrying.
Remote/GitHub downloads, bulk imports, and automatic updates remain unsupported.

## Where skills live

Only these native roots are scanned:

1. Personal: `~/.empty-vessel/skills/<name>/SKILL.md`, or
   `$EMPTY_VESSEL_HOME/skills/<name>/SKILL.md` when configured.
2. Project: `<git-worktree-root>/.empty-vessel/skills/<name>/SKILL.md`.
   Outside Git, the current working directory is the project root.

A project skill overrides a personal skill with the same name. `/skills` reports
shadowing and invalid entries. Discovery is shallow: each immediate skill
folder contains its own `SKILL.md`. Discovery does not automatically scan
`.claude/skills`, `.agents/skills` or arbitrary paths. To copy one existing local
skill from those locations, use `/skills import`. Remote packages are not fetched. Symlinks that escape the
skill root/directory are rejected.

## Metadata and arguments

The YAML frontmatter requires a nonempty `description`. A `name` can be supplied;
otherwise the directory name is used. Names use lowercase letters, digits and
single separating hyphens, at most 64 characters.

```yaml
---
name: release-check
description: Check the release checklist without publishing anything.
user-invocable: true
disable-model-invocation: true
---
```

- `user-invocable` defaults to `true`. Set it to `false` to reject both user
  invocation forms; model invocation can still be allowed.
- `disable-model-invocation` defaults to `false`. Set it to `true` to omit the
  skill from model discovery and reject model activation. Explicit user
  activation is still allowed if `user-invocable` is true.
- `$ARGUMENTS` is replaced literally with the supplied argument text. Without
  that placeholder, arguments are appended in a `skill-arguments` block.
  Arguments are not parsed as shell commands or evaluated as code.
- Passive `license`, `compatibility` and `metadata` fields are accepted.
  Unsupported frontmatter fields reject activation rather than silently
  enabling another tool's features.

Both invocation controls can be disabled; the catalog reports that condition.
Changes to frontmatter or resolved paths require `/skills reload`. Activation
rereads the file body; a listing does not preload instructions or supporting
files into model context.

## Activation and limits

User activation is host-owned: the host validates permissions, loads the full
instructions, records a `skill` session event with the activation content, and
passes that content—not merely the slash command—to the answer turn. The turn
is marked as an explicit skill request for System Two routing. Failed or
interrupted invocations do not leave that routing flag enabled.

A skill is instruction text, not a plugin or permission grant. Activation does
not automatically run scripts, load support files, or change the working
directory. Relative resources are identified by the skill's directory in its
activation envelope; using them still requires ordinary tool operations.
Dynamic shell injection (`!` followed by a backtick command) is rejected.
Hooks, tool permissions, forked agents and other execution extensions are not
implemented by skill metadata. Existing tool safety and approval rules still
apply; inspect skills before invoking them.

Discovery and activation enforce size and scan limits. Oversized or invalid
entries produce diagnostics/errors instead of executing anything. Use `/skills`
to inspect diagnostics and `/skills reload` after fixing an entry. Reloading
refreshes discovery; it does not retract instructions already used in earlier
turns.
