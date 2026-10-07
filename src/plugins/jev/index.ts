import { Effect, Layer, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { settings } from "./config"
import { makeJevSystemOne, MockJevHttp } from "./jev"
import { setup } from "./setup"
import { ConfigError, type Plugin, pluginSettings } from "empty-vessel"

// Jev as System One: the real API, with its key from plugins.jev.config.
export const jev: Plugin = {
  name: "jev",
  settings,
  setup,
  provides: {
    systemOne: pluginSettings("jev", settings).pipe(
      Effect.mapError(() => new ConfigError({ message: 'systemOne.use is "jev" but there\'s no Jev API key (plugins.jev.config.apiKey): run empty-vessel setup' })),
      Effect.map(({ apiKey }) => makeJevSystemOne(apiKey).pipe(Layer.provide(FetchHttpClient.layer))),
    ),
  },
}

// Jev's real code against a mock server: no key, no network.
export const jevMock: Plugin = {
  name: "jev-mock",
  provides: { systemOne: Effect.succeed(makeJevSystemOne(Redacted.make("mock")).pipe(Layer.provide(MockJevHttp))) },
}
