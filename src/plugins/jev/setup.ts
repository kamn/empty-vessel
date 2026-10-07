import { Effect } from "effect"
import { type PluginSetup } from "empty-vessel"

// Does this Jev key work? One tiny request: a 401 means no.
const keyWorks = (key: string) =>
  Effect.promise(() =>
    fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state: { goal: "setup check" }, questions: { ok: { type: "noul", instructions: "Is this a test?", criteria: { true: "yes", false: "no" } } } }),
      signal: AbortSignal.timeout(15_000),
    }).then((r) => r.ok, () => false))

// What Jev needs: an API key, tried once before it's saved.
export const setup: PluginSetup = {
  name: "jev",
  kind: "systemOne",
  title: "Jev, from TypeSafe AI",
  about: "get an API key at https://typesafe.ai · docs: https://docs.typesafe.ai",
  asks: [{ setting: "apiKey", prompt: "Jev API key", secret: true, test: keyWorks, failed: "Jev refused it (or couldn't be reached): check the key and run setup again" }],
}
