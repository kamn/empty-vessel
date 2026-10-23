import { Context, Effect, Option } from "effect"
import { AskUser } from "../ui/ask"

// A command, or a call to a tool source's tool (an MCP server's): providers that only judge commands allow the other kinds.
export type Action =
  | { readonly kind: "shell"; readonly command: string; readonly cwd: string; readonly timeoutMs: number }
  | { readonly kind: "mcp"; readonly source: string; readonly tool: string; readonly args: unknown }

export type GuardVerdict =
  | { readonly decision: "allow" }
  | { readonly decision: "deny" | "revise" | "ask"; readonly reason: string }

export interface ActionGuardProvider {
  readonly beforeAction: (action: Action) => Effect.Effect<GuardVerdict, unknown>
}

export const ActionGuard = Context.Reference<ActionGuardProvider>("empty-vessel/ActionGuard", {
  defaultValue: () => ({ beforeAction: () => Effect.succeed({ decision: "allow" }) }),
})

const guardTimeoutMs = 10_000
const deny = (reason: string): GuardVerdict => ({ decision: "deny", reason })
// An mcp action's args are copied (JSON), so a provider can't change what the call is made with.
const freezeAction = (action: Action): Action => Object.freeze(action.kind === "mcp"
  ? { kind: action.kind, source: action.source, tool: action.tool, args: JSON.parse(JSON.stringify(action.args ?? {})) }
  : { kind: action.kind, command: action.command, cwd: action.cwd, timeoutMs: action.timeoutMs })

// What the approval question shows of the action.
const describeAction = (action: Action) => action.kind === "mcp"
  ? `Tool: ${action.source}.${action.tool}\nArguments:\n${JSON.stringify(action.args, null, 1).slice(0, 2000)}`
  : `Command:\n${action.command}\nCwd: ${action.cwd}\nTimeout: ${action.timeoutMs} ms`

// Copy validated fields so providers cannot change a verdict after returning it.
const validateVerdict = (value: unknown): GuardVerdict => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return deny("Invalid guard verdict")

  const { decision, reason } = value as { decision?: unknown; reason?: unknown }
  if (decision === "allow") return { decision }

  if ((decision === "deny" || decision === "revise" || decision === "ask") && typeof reason === "string" && reason.trim().length > 0) {
    return { decision, reason }
  }

  return deny("Invalid guard verdict")
}

const checkGuard = (guard: ActionGuardProvider, action: Action): Effect.Effect<GuardVerdict> =>
  Effect.suspend(() => {
    const result = guard.beforeAction(action)
    return Effect.isEffect(result) ? result : Effect.succeed(deny("Guard did not return an Effect"))
  }).pipe(
    Effect.map(validateVerdict),
    Effect.timeout(guardTimeoutMs),
    Effect.catchCause(() => Effect.succeed(deny("Guard failed or timed out"))),
  )

/** All required providers are checked before approval; a deny may short circuit. */
export const combineActionGuards = (guards: ReadonlyArray<ActionGuardProvider>): ActionGuardProvider => {
  const required = [...guards]
  const rank = { allow: 0, ask: 1, revise: 2, deny: 3 } as const
  const collect = (current: GuardVerdict, next: GuardVerdict): GuardVerdict => {
    if (rank[next.decision] > rank[current.decision]) return next

    if (next.decision !== "allow" && current.decision === next.decision) {
      return { decision: next.decision, reason: `${current.reason}\n${next.reason}` }
    }

    return current
  }

  return {
    beforeAction: (action) => Effect.gen(function* () {
      const proposal = freezeAction(action)
      let verdict: GuardVerdict = { decision: "allow" }

      for (const guard of required) {
        const next = yield* checkGuard(guard, proposal)
        if (next.decision === "deny") return next

        verdict = collect(verdict, next)
      }

      return verdict
    }),
  }
}

// Preview the policy without asking a human or executing anything.
export const evaluateAction = (action: Action): Effect.Effect<GuardVerdict> =>
  Effect.gen(function* () {
    return yield* checkGuard(yield* ActionGuard, freezeAction(action))
  }).pipe(Effect.catchCause(() => Effect.succeed(deny("Policy evaluation failed"))))

// `alwaysAsk`: the reason a human must approve even when every provider allows (a source marked `ask`).
export const authorizeAction = (action: Action, alwaysAsk?: string): Effect.Effect<GuardVerdict> =>
  Effect.gen(function* () {
    const proposal = freezeAction(action)
    const evaluated = yield* evaluateAction(proposal)
    const verdict: GuardVerdict = alwaysAsk && evaluated.decision === "allow" ? { decision: "ask", reason: alwaysAsk } : evaluated
    if (verdict.decision !== "ask") return verdict

    const user = yield* Effect.serviceOption(AskUser)
    if (Option.isNone(user)) return deny(`Approval unavailable (no UI): ${verdict.reason}`)

    const question = `ActionGuard approval\n${describeAction(proposal)}\nReason: ${verdict.reason}`
    const answers = yield* Effect.suspend(() => user.value.ask([{
      question,
      options: ["Allow once", "Deny"],
    }])).pipe(Effect.timeout(300_000))

    return answers.length === 1 && answers[0]?.answer === "Allow once"
      ? { decision: "allow" } as const
      : deny(`Approval rejected: ${verdict.reason}${answers[0]?.note ? ` (${answers[0].note})` : ""}`)
  }).pipe(Effect.catchCause(() => Effect.succeed(deny("Authorization failed or timed out"))))

// A worker supplies its host authorization call explicitly, not via a service the cell could replace.
// This transport may wait for a human; only policy handlers have the 10-second timeout.
export const withActionGuard = <E>(action: Action, execute: Effect.Effect<string, E>, authorization: Effect.Effect<unknown, unknown> = authorizeAction(action)): Effect.Effect<string, E> =>
  authorization.pipe(
    Effect.map(validateVerdict),
    Effect.catchCause(() => Effect.succeed(deny("Authorization unavailable or failed"))),
    Effect.flatMap((verdict) => {
    if (verdict.decision === "allow") return execute
    if (verdict.decision === "ask") return Effect.succeed("ActionGuard deny: unresolved approval. Action not executed.")

    const recommendation = verdict.decision === "revise"
      ? " Revise the proposal using the recommendation above and submit it again."
      : ""
    return Effect.succeed(`ActionGuard ${verdict.decision}: ${verdict.reason}\nAction not executed.${recommendation}`)
  }))
