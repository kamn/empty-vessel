import { Effect } from "effect"
import { Config, ConfigError } from "./base/config"
import { ActionGuardFromConfig, SystemOneFromConfig } from "./plugins"
import { evaluateAction, type Action } from "./tools/action-guard"

export type GuardPreviewArgs = {
  readonly command: string
  readonly policy?: string
  readonly prompt?: string
  readonly timeoutSeconds?: number
}

// Evaluate configured policy only: no Kernel.exec, shell execution, approval UI, or config writes.
export const guardPreview = (args: GuardPreviewArgs) => Effect.gen(function* () {
  const config = yield* Config
  const timeoutSeconds = args.timeoutSeconds ?? 120
  if (!args.command.trim() || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > Number.MAX_SAFE_INTEGER / 1000) {
    return yield* new ConfigError({ message: "guard requires a nonempty command and a positive integer timeout in seconds" })
  }

  const policies = args.policy === undefined ? config.actionGuard.use : [args.policy]
  if (args.prompt !== undefined && !policies.includes("jev-guard")) {
    return yield* new ConfigError({ message: "--policy-prompt requires jev-guard (select it with --policy jev-guard)" })
  }

  const priorSettings = config.plugins["jev-guard"]?.config
  if (args.prompt !== undefined && priorSettings !== undefined && (typeof priorSettings !== "object" || priorSettings === null || Array.isArray(priorSettings))) {
    return yield* new ConfigError({ message: "plugins.jev-guard.config must be an object" })
  }
  const settings = typeof priorSettings === "object" && priorSettings !== null ? priorSettings : {}
  const plugins = args.prompt === undefined ? config.plugins : {
    ...config.plugins,
    "jev-guard": {
      ...config.plugins["jev-guard"],
      config: { ...settings, prompt: args.prompt },
    },
  }
  const selected = { ...config, plugins, actionGuard: { use: [...policies] } }
  const action: Action = { kind: "shell", command: args.command, cwd: process.cwd(), timeoutMs: timeoutSeconds * 1000 }
  const verdict = yield* evaluateAction(action).pipe(
    Effect.provide(ActionGuardFromConfig),
    Effect.provide(SystemOneFromConfig),
    Effect.provideService(Config, selected),
  )

  return {
    mode: "dry-run" as const,
    executed: false as const,
    policies,
    action,
    verdict,
    ...(policies.length ? {} : { note: "No guards selected; the default is allow." }),
  }
})
