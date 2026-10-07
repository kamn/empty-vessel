# ActionGuard

ActionGuard is an opt-in policy hook for shell execution. With `actionGuard.use: []` (the default), commands behave as before. No user configuration is changed by installing this code.

## Execution boundary

A kernel worker sends the command, working directory, and timeout to the host. The host evaluates the configured guards and, when needed, asks the human. The worker only executes after an `allow` reply. Shell execution stays inside the worker with its existing restricted environment; it does not gain the host's environment variables.

The default Kernel uses this bridge for both systems' cells and sub-agents. Host-side commands, including saved checks and `!command`, use the same authorization logic. A missing bridge or unavailable approval service leaves the command unexecuted. A custom Kernel implementation is responsible for enforcing its own equivalent boundary.

The reserved `$actionGuard` host function cannot be replaced by a supplied cell host handler. Each run captures its caller's services, including the active guard and approval UI. A cell's local Effect services do not choose the host's policy.

## Verdicts

| Decision | Behavior |
| --- | --- |
| `allow` | Execute the exact proposed command once. |
| `deny` | Do not execute; return the reason. |
| `revise` | Do not execute; return feedback asking for a revised proposal. |
| `ask` | Show the full command, working directory, timeout, and reason to the human. Only `Allow once` approves. |

Non-allow verdicts require a nonempty `reason`. Multiple configured guards combine as **deny > revise > ask > allow**. A later allow cannot override a restriction, and the approval question is shown only after all required guards have been checked. Guards receive frozen copies of the action.

Policy evaluation is bounded by a 10-second timeout; invalid responses, errors, or timeouts deny execution. Human approval has a separate five-minute timeout. Cancellation leaves a pending action unexecuted, even if approval arrives afterward. Approval applies only to that proposal and is not cached.

`revise` does not automatically retry or escalate. The agent receives feedback and can propose another command, which is checked again. No model can turn a policy denial into human authorization.

## Test a policy without executing commands

From the checkout, use the `guard` subcommand. The `--command` argument is data: it is never sent to a shell for execution.

```sh
bun src/main.ts guard --policy no-absolute-rm --command 'rm -rf /tmp/folder'
bun src/main.ts guard --policy no-absolute-rm --command 'rm -rf ./tmp/folder'
```

The JSON output includes `mode: "dry-run"`, `executed: false`, the selected policies, the proposed action, and the verdict. The first example denies; the second allows under that one policy. A reported allow is not execution or a saved approval.

Omit `--policy` to preview the configured guard list. `--policy NAME` tests only that policy for this invocation, without saving any configuration changes. An empty configured list explicitly reports default allow. `ask` is shown as a verdict without asking a human. Optional `--timeout SECONDS` describes the proposed action's execution timeout; it does not execute it.

Policy plugins still run their evaluation code. For example, a Jev preview sends the policy and action to Jev and incurs a model request. The proposed shell command itself is never run.

## Bundled policy: jev-guard

`jev-guard` takes a trusted policy prompt and evaluates each action through the configured Jev System One provider. It requires `systemOne.use: "jev"`, a working existing Jev API key, and a nonblank prompt. Fake/mock providers are refused rather than silently approving.

Add these settings to your existing configuration, preserving other plugin settings and your existing Jev credentials:

```json
{
  "systemOne": { "use": "jev" },
  "actionGuard": { "use": ["no-absolute-rm", "jev-guard"] },
  "plugins": {
    "jev-guard": {
      "config": {
        "prompt": "Allow read-only inspection commands. Deny deletion or publishing. Request revision for fixable policy violations, and ask a human when approval is needed."
      }
    }
  }
}
```

Each evaluation sends one question with four options: **allow, deny, revise, ask**. Jev selects its highest-ranked choice, which is used directly without a confidence threshold. The trusted prompt is separate from the action evidence, which is explicitly labelled untrusted.

- `allow`: execute the command as proposed.
- `deny`: block execution.
- `revise`: return feedback without execution or automatic retries.
- `ask`: request human approval; only exact `Allow once` authorizes execution. Dry-run previews report `ask` without prompting.

Missing/malformed responses, model failures, and policy timeouts still deny execution. Confidence must be a valid number in [0, 1], but its magnitude does not change the selected verdict. The former `minConfidence` setting has been removed; remove it from any manually configured `jev-guard` settings.

Test a temporary prompt without saving it:

```sh
bun src/main.ts guard --policy jev-guard \
  --policy-prompt 'Allow only the exact command echo hello. Deny everything else.' \
  --command 'echo hello'
```

`--policy-prompt` overrides only the Jev guard's prompt for this preview. If Jev selects `allow` at confidence `0.88`, this guard now returns **allow**, not deny. Model choices are not a security guarantee; keep deterministic restrictions in the guard list. A Jev allow never overrides another guard's denial. The existing multi-guard precedence remains **deny > revise > ask > allow**; that is separate from Jev selecting its highest-ranked option.

Only the action (command, working directory, timeout) and configured policy are available here—not the user's whole conversation or intent. Command text is sent to Jev, so avoid putting secrets in commands. No System Two call or retry loop is added by this guard.

## Bundled policy: no-absolute-rm

For a simple first policy, select the bundled `no-absolute-rm` guard. No model, API key, external checker, or outside plugin path is needed. Add its name to your existing guard list; do not replace other configured guards:

```json
{
  "actionGuard": { "use": ["no-absolute-rm"] }
}
```

It refuses explicit absolute operands to `rm`, regardless of whether the command uses `-rf`, `-f`, or no flags. These are examples to evaluate, not commands to run:

| Proposal | Verdict |
| --- | --- |
| `rm -rf /tmp/folder` | `deny` |
| `rm -f '/tmp/a file'` | `deny` |
| `rm -rf ./tmp/folder` | `allow` |
| `rm -rf "$TARGET"` | `revise`: provide a literal relative target |
| `echo 'rm -rf /tmp/folder'` | `allow`: not an rm invocation |

The guard checks a limited shell grammar without executing the command. It considers command lists, quoting, and supported wrappers; unsupported or dynamic execution requires revision rather than an assumed allow. It does not silently rewrite an absolute target to a relative one: that would change which file is deleted.

This is a **syntactic absolute-path rule**, not a promise that deletion stays inside the repository. Relative paths can still traverse parents, follow symlinks, or run after a working-directory change. Other deletion mechanisms (for example, a program that deletes files internally) are outside this rule. Use a sandbox for a filesystem boundary.

The policy is available but not enabled automatically; existing configuration is preserved.

## Example plugin: confirm every shell command

A guard is a plugin provider, while `beforeAction` is the hook. This example is intentionally strict: it asks about every command, including routine checks.

```ts
import { Effect, Layer } from "effect"
import { ActionGuard, type Plugin } from "empty-vessel"

const plugin: Plugin = {
  name: "confirm-shell",
  core: "0.0.2",
  provides: {
    actionGuard: Effect.succeed(Layer.succeed(ActionGuard, {
      beforeAction: () => Effect.succeed({
        decision: "ask",
        reason: "This project's policy requires approval before shell execution.",
      }),
    })),
  },
}

export default plugin
```

Add the provider to your existing configuration, preserving other settings:

```json
{
  "actionGuard": { "use": ["confirm-shell"] },
  "plugins": {
    "confirm-shell": { "path": "/absolute/path/to/confirm-shell.ts" }
  }
}
```

Guard plugins may capture System One at layer construction or run a trusted checker. The bundled `jev-guard` supplies a model policy; there is no built-in external command-checker protocol. A checker must not call the guarded shell entry recursively; its own execution is trusted plugin code.

## Scope and limits

This version guards shell commands, not direct file writes, external tool-source calls, or arbitrary trusted plugin code. Guard plugins and configuration are trusted. ActionGuard is not an OS sandbox and does not prevent a previously allowed command from starting other programs. Use process/filesystem/network isolation for that boundary.

Generic `makeKernel` remains independent of application policy. Applications using empty-vessel's shell built-ins should use `makeGuardedKernel` (the default `Kernel.open`) or provide an equivalent authorization bridge. A bare kernel with these built-ins and no bridge refuses shell execution.
