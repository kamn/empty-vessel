import { Effect, Option } from "effect"
import { readCodexAuth } from "./codex"
import { type PluginSetup } from "empty-vessel"

// What Codex needs: the Codex CLI, logged in (System Two runs on your ChatGPT plan through it).
export const setup: PluginSetup = {
  name: "codex",
  kind: "systemTwo",
  title: "Codex, on your ChatGPT plan through the Codex CLI",
  about: "https://github.com/openai/codex",
  checks: [
    { what: "the Codex CLI", ok: Effect.sync(() => Bun.which("codex") !== null), fix: "install it: https://github.com/openai/codex" },
    { what: "logged in to Codex", ok: Effect.option(readCodexAuth).pipe(Effect.map(Option.isSome)), fix: "run `codex login` (or `codex` once if it expired), then `empty-vessel setup` again" },
  ],
  defaults: { model: "gpt-6-astra" },
}
