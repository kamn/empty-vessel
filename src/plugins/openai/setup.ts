import { Effect } from "effect"
import { type PluginSetup } from "empty-vessel"
import { DEFAULT_BASE_URL } from "./config"

// The models the server lists (GET …/models), with the address and key given so far; none if it can't be reached
// or refuses (a 401 is a bad key).
const models = (settings: Readonly<Record<string, unknown>>, key = settings.apiKey) =>
  Effect.promise(() =>
    fetch(`${String(settings.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(15_000),
    }).then(async (r) => (r.ok ? ((await r.json()) as { data?: Array<{ id: string }> }).data?.map((m) => m.id).sort() ?? [] : undefined), () => undefined))

// What an OpenAI-compatible API needs: its address, a key (tried once: does it list the models?), and which model,
// picked from the ones it lists. Under the plugin's name, so each copy (plugins.<name>.from) is set up on its own.
export const setupAs = (name: string): PluginSetup => ({
  name,
  kind: "systemTwo",
  title: name === "openai" ? "Any OpenAI-compatible API (OpenAI, OpenRouter, a local server)" : `${name}, an OpenAI-compatible API`,
  asks: [
    { setting: "baseUrl", prompt: `API address, up to /v1 (skipped: ${DEFAULT_BASE_URL})`, optional: true },
    { setting: "apiKey", prompt: "API key (a local server may need none)", secret: true, optional: true,
      test: (key, settings) => models(settings, key).pipe(Effect.map((m) => m !== undefined)), failed: "the server refused it (or couldn't be reached): check the address and key" },
    { setting: "model", prompt: "Model", choices: (settings) => models(settings).pipe(Effect.map((m) => m ?? [])) },
  ],
})
