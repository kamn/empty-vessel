import { Effect, Option } from "effect"
import { readCodexAuth } from "./auth"
import { type PluginSetup } from "empty-vessel"

// Native ChatGPT login requires no Codex CLI; an existing CLI login remains a read-only fallback.
export const setup: PluginSetup = {
  name: "codex",
  kind: "systemTwo",
  title: "Codex, on your ChatGPT plan",
  about: "https://github.com/openai/codex",
  checks: [
    { what: "logged in to Codex", ok: Effect.option(readCodexAuth).pipe(Effect.map(Option.isSome)), fix: "run `empty-vessel login codex` (or add `--device-code` for a remote terminal), then `empty-vessel setup` again" },
  ],
  defaults: { model: "gpt-6-astra" },
}
