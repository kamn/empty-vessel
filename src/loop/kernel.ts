import { mkdirSync } from "node:fs"
import { Context, Effect } from "effect"
import { applyAgent, loadAgent } from "../base/agents"
import { type CellResult, describeCell, type HostFunctions } from "../kernel/kernel"
import { Kernel } from "../tools/kernel-service"
import { recheck } from "./recheck"
import type { Grants } from "../base/grants"
import { Memory, type Scope, SCOPES } from "../base/memory"
import { fillParameters, helpers, systemOneTools, kernelImports, libraryDir, loadLibrary, loadPool, promote, TSC, usableWith, writeBuiltins } from "./library"
import { record } from "./pool"
import { kernelSources, sourceTools } from "./sources"
import type { KernelArgs } from "../system-two/systemtwo"
import { type Ctx, type Needs, timed } from "./turnkit"

// empty-vessel's use of the kernel library (src/kernel): each session (the root and every sub-agent)
// has its own kernel in its folder; cells get empty-vessel's built-ins (src/tools/kernel-builtins.ts) and reach System One and
// sub-agents through the host functions below.

// What cells reach through `call`: System One, the re-check, sub-agents as jobs, and promotion into the library. Shared by
// System Two's kernel and System One's. `services`: empty-vessel's systems, since a hook runs inside System Two's own Effect.
export const makeHost = (ctx: Ctx, services: Context.Context<Needs>): HostFunctions => {
  const host: HostFunctions = {
    systemOne: (arg: unknown) => {
      const { evidence, questions } = arg as { evidence: unknown; questions: Record<string, { question: string; options: Record<string, string> }> }
      // A short goal, not the whole task: System One answers questions about this evidence (it judged "done" against the literal goal before).
      return timed(ctx, "systemOne", ctx.systemOne.decide({ goal: "Answer the questions about this evidence", evidence }, questions)).pipe(Effect.map(({ result }) => result.answers))
    },
    // judge's re-check of the answers System One couldn't settle: one direct model call with the same evidence.
    recheck: (arg: unknown) => {
      const { evidence, questions } = arg as { evidence: string; questions: Record<string, { question: string; options: Record<string, string> }> }
      return recheck("Answer the questions about this evidence.", evidence, questions).pipe(Effect.map(({ answers }) => answers), Effect.provideContext(services))
    },
    // A library tool's parameters filled from a request by the small model (a pick, and promote's check of a new tool).
    fill: (arg: unknown) => {
      const { name, parameters, request } = arg as { name: string; parameters: Record<string, string>; request: string }
      return timed(ctx, "fill", fillParameters(name, parameters, request)).pipe(Effect.map(({ result }) => ({ args: result.args, missing: result.missing })), Effect.provideContext(services))
    },
    // Sub-agents are jobs (src/loop/jobs.ts): spawn returns an id at once, the sub-agent runs in the host (so it outlives
    // the cell), and System Two collects it with wait or drops it with cancel.
    // `tools`: what the sub-agent's kernel grants, narrowed from this one's (never more). `agent`: the agent it works as
    // (src/base/agents.ts), checked here, so an unknown name or settings that don't make a valid config fail this call
    // and start nothing.
    spawn: (arg: unknown) => {
      const { task, tools, agent } = typeof arg === "object" && arg !== null ? (arg as { task: string; tools?: Partial<Grants>; agent?: string }) : { task: String(arg), tools: undefined, agent: undefined }
      if (ctx.depth >= ctx.config.maxDepth) return Effect.fail(`too deep for another sub-agent (depth ${ctx.depth} of ${ctx.config.maxDepth})`)

      return Effect.gen(function* () {
        const as = agent === undefined ? undefined : yield* loadAgent(agent).pipe(Effect.flatMap((a) => applyAgent(ctx.config, a).pipe(Effect.map((config) => ({ ...a, config })))))
        return yield* ctx.conversation.jobs.spawn(String(task), ctx.spawn(String(task), { tools, agent: as }).pipe(Effect.provideContext(services)))
      }).pipe(Effect.mapError((e) => (typeof e === "object" && e !== null && "message" in e ? String(e.message) : e)))
    },
    wait: (arg: unknown) => {
      const { ids, seconds } = arg as { ids: ReadonlyArray<string>; seconds: number }
      return ctx.conversation.jobs.wait(ids, seconds)
    },
    cancel: (id: unknown) => ctx.conversation.jobs.cancel(String(id)),
    jobs: () => Effect.sync(() => ctx.conversation.jobs.list()),
    // One of System Two's definitions becomes an option System One can pick (src/loop/library.ts checks it first).
    promote: (arg: unknown) => promote(libraryDir(process.cwd()), `${ctx.session.dir}/kernel`, ctx.session.id, host, arg as { name: string; description: string; example: string; for?: "systemOne" | "systemTwo"; parameters?: Record<string, string> }, ctx.config.adoption.promoteTo),
    // The library, for System Two: what each tool is for (it can import any of them from "kernel").
    tools: () => Effect.sync(() => {
      const dir = libraryDir(process.cwd()), usable = usableWith(ctx.config.kernel.tools)
      const forSystemOne = [...systemOneTools(loadLibrary(dir)), ...loadPool(dir).filter((e) => e.for === "systemOne")].filter(usable).map((e) => [e.name, `${e.description}. Call: ${e.parameters ? `${e.name}({ ${Object.entries(e.parameters).map(([k, d]) => `${k}: string /* ${d} */`).join(", ")} })` : `${e.name}(request), with the user's request as a string`}`])
      const kept = helpers(loadLibrary(dir)).filter(usable).map((e) => [e.name, e.description])
      const onTrial = loadPool(dir).filter((e) => e.for === "systemTwo").filter(usable).map((e) => [e.name, `(on trial) ${e.description}`])
      return Object.fromEntries([...forSystemOne, ...kept, ...onTrial])
    }).pipe(Effect.flatMap((own) => sourceTools.pipe(Effect.map((outside) => ({ ...own, ...outside }))))),
    // Hand library tools to System One: always in its options from now on this session (its shortlist may miss them).
    // Recorded in the session too, so a resumed session keeps them.
    handTools: (arg: unknown) => Effect.gen(function* () {
      const known = new Set(systemOneTools(loadLibrary(libraryDir(process.cwd()))).filter(usableWith(ctx.config.kernel.tools)).map((e) => e.name))
      const names = (Array.isArray(arg) ? arg : [arg]).map(String)
      const handed = names.filter((n) => known.has(n))
      const unknown = names.filter((n) => !known.has(n))

      for (const n of handed) {
        ctx.conversation.tools.add(n)
        yield* ctx.session.record("tools", n).pipe(Effect.ignore)
      }
      return `System One will see ${handed.join(", ") || "nothing new"} from now on this session${unknown.length ? `; not in the library: ${unknown.join(", ")}` : ""}`
    }),
    // The memory built-in: a change to what later sessions are told. Recorded in the session and
    // shown to the user at the end of the turn; a refusal (full, no or several matching entries) comes back as text.
    memory: (arg: unknown) => Effect.gen(function* () {
      const { action, scope, text = "", old = "" } = arg as { action: string; scope: Scope; text?: string; old?: string }
      if (!SCOPES.includes(scope)) return `not done: no memory scope "${scope}" (agent or project)`
      if (action !== "remove" && !text.trim()) return "not done: the entry is empty"

      const m = yield* Memory
      const change = action === "add" ? m.add(scope, text.trim()) : action === "replace" ? m.replace(scope, old, text.trim()) : m.remove(scope, old)
      const refused = yield* change.pipe(Effect.as(undefined), Effect.catch((e) => Effect.succeed(e.message)))
      if (refused) return `not done: ${refused}`

      const line = `${action === "add" ? "remembered" : action === "replace" ? "updated" : "forgot"} (${scope}): ${action === "remove" ? old : text.trim()}`
      ctx.conversation.remembered.push(line)
      yield* ctx.session.record("memory", line).pipe(Effect.ignore)
      return `done: ${line}`
    }).pipe(Effect.provideContext(services)),
  }
  return host
}

// `trial`: pool tools offered to System Two this turn; a cell that imports one records a use (and whether it ran OK).
export const makeKernelHook = (ctx: Ctx, services: Context.Context<Needs>, trial: ReadonlyArray<string> = [], turn = 0) => {
  mkdirSync(`${ctx.session.dir}/kernel`, { recursive: true })
  const g = ctx.config.kernel.tools // what this kernel grants: the built-ins it exports and provides, the tools it offers
  const builtins = writeBuiltins(`${ctx.session.dir}/kernel/builtins.ts`, libraryDir(process.cwd()), g) // empty-vessel's built-ins and the library
  const kernel = Context.get(services, Kernel).open({ dir: `${ctx.session.dir}/kernel`, builtins, tsc: TSC, sources: g.sources ? kernelSources() : [] })
  const host = makeHost(ctx, services)

  // A code cell, or a text cell (name + text).
  return (args: typeof KernelArgs.Type) => {
    const cell = args.text !== undefined && args.name ? kernel.text(args.name, args.text, args.summary)
      : args.code !== undefined ? kernel.run(args.code, host, args.summary)
      : undefined
    if (!cell) return Effect.succeed("give code (a code cell), or name and text (a text cell)")

    const used = kernelImports(args.code ?? "").filter((n) => trial.includes(n))
    const recordUse = (r: CellResult) => Effect.sync(() => {
      for (const tool of used) record(libraryDir(process.cwd()), { session: ctx.session.id, turn, tool, for: "systemTwo", event: "used", ok: r.status === "ok" })
    })
    return cell.pipe(Effect.tap(recordUse), Effect.map(describeCell), Effect.catch((e) => Effect.succeed(`the kernel failed: ${e}`)), Effect.provideContext(services))
  }
}
