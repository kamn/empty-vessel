import { Effect, Layer, Scope } from "effect"
import { Config } from "../base/config"
import { ReviewerLive } from "../learning/reviewer"
import { AskFromConfig, describeSystemTwo, FillFromConfig, SystemTwoFromConfig } from "../plugins/index"

// What comes from the config's System Two plugin: SystemTwo, Fill, and the Reviewer over its Ask.
export const SystemTwoLayers = Layer.mergeAll(SystemTwoFromConfig, FillFromConfig, ReviewerLive.pipe(Layer.provide(AskFromConfig)))

// System Two as `config` says (another plugin, model or reasoning than the session's), for /model and for a sub-agent
// working as an agent: a Config of it, its SystemTwo and Fill, and a Reviewer over its Ask (the reviewer takes Ask once,
// when it's made), built in the caller's scope, and its description. Fails as the config would (an unknown plugin, a
// missing login): the caller changes nothing.
export const systemTwoServices = (config: Config["Service"]) =>
  Effect.gen(function* () {
    const given = Layer.succeed(Config, config)
    const layer = SystemTwoLayers.pipe(Layer.provideMerge(given))

    // A fresh memo map: the one already in this process holds the start-up System Two, and would hand it back again.
    const services = yield* Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), yield* Scope.Scope)
    return { services, describe: yield* describeSystemTwo.pipe(Effect.provide(given)) }
  })
