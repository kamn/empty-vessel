import { mkdirSync } from "node:fs"
import { Context, Effect } from "effect"
import { discoverSkills, loadSkill, saveSkill } from "../base/skills"
import { describeFlags } from "../base/skill-scan"
import { EMPTY_VESSEL_HOME } from "../base/home"
import { has } from "../base/grants"
import { makeMedia } from "../base/media"
import { KERNEL_PASSTHROUGH } from "../kernel/instructions-marker"
import { applyAgent, loadAgent } from "../base/agents"
import { type CellResult, describeCell, type HostFunctions } from "../kernel/kernel"
import { Kernel } from "../tools/kernel-service"
import { DETACHED, jobsRefusal, TIMER, Timers } from "./jobs"
import { recheck } from "./recheck"
import type { Grants } from "../base/grants"
import { Memory, type Scope, SCOPES } from "../base/memory"
import { type PastArgs, pastSessions } from "./past"
import { fillParameters, helpers, systemOneTools, kernelImports, libraryDir, loadLibrary, loadPool, promote, TSC, usableWith, writeBuiltins } from "./library"
import { record } from "./pool"
import { kernelSources, sourceTools } from "./sources"
import type { KernelArgs } from "../system-two/systemtwo"
import { type Ctx, type Needs, timed } from "./turnkit"

// empty-vessel's use of the kernel library (src/kernel): each session (the root and every sub-agent)
// has its own kernel in its folder; cells get empty-vessel's built-ins (src/tools/kernel-builtins.ts) and reach System One and
// sub-agents through the host functions below.

// Sub-agents one turn may start, all its kernels together (each sub-agent's own turn has its own): a loop that spawns
// per item stops here instead of fanning out without end. ponytail: fixed; a config setting if real work needs more.
export const MAX_SPAWNS_PER_TURN = 16
const spawned = new WeakMap<Ctx, number>() // per turn: a turn has one Ctx

// What cells reach through `call`: System One, the re-check, sub-agents as jobs, and promotion into the library. Shared by
// System Two's kernel and System One's. `services`: empty-vessel's systems, since a hook runs inside System Two's own Effect.
// `home`: where personal skills are (saveSkill).
export const makeHost = (ctx: Ctx, services: Context.Context<Needs>, home = EMPTY_VESSEL_HOME): HostFunctions => {
  const host: HostFunctions = {
    skill: (arg: unknown) => Effect.gen(function* () {
      if (!has(ctx.config.kernel.tools, "read")) return yield* Effect.fail(new Error("skill requires the files read grant"))
      if (typeof arg !== "object" || arg === null || Array.isArray(arg)) return yield* Effect.fail(new Error("skill expects { name, arguments? }"))
      const input = arg as Record<string, unknown>
      if (typeof input.name !== "string" || !input.name.trim() || (input.arguments !== undefined && typeof input.arguments !== "string")) return yield* Effect.fail(new Error("skill expects a nonempty name and optional string arguments"))
      const catalog = ctx.conversation.skills ??= discoverSkills(process.cwd())
      // Never accept an origin from a cell, including a forged extra field.
      const content = yield* loadSkill(catalog, { name: input.name, ...(input.arguments === undefined ? {} : { arguments: input.arguments }) }, "model")
      yield* ctx.session.record("skill", input.name, { content })
      const active = ctx.conversation.activeSkills ??= {}
      Object.defineProperty(active, input.name, { value: content, enumerable: true, writable: true, configurable: true })
      return content
    }),
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
    // `detach`: the background agent runs it as a session of its own (src/loop/jobs.ts Timers), so it outlives this turn
    // and isn't one of its jobs; its result comes back as a new turn. Only the main agent's, with its session's own
    // settings (no tools or agent to narrow), and never from a run a job or a detached sub-agent started (R17).
    spawn: (arg: unknown) => {
      const { task, tools, agent, detach } = typeof arg === "object" && arg !== null ? (arg as { task: string; tools?: Partial<Grants>; agent?: string; detach?: boolean }) : { task: String(arg), tools: undefined, agent: undefined, detach: false }
      if (ctx.depth >= ctx.config.maxDepth) return Effect.fail(`too deep for another sub-agent (depth ${ctx.depth} of ${ctx.config.maxDepth})`)
      if (detach) {
        const timers = Context.get(services, Timers), origin = timers.origin()
        if (ctx.depth > 0 || tools !== undefined || agent !== undefined) return Effect.fail("a detached sub-agent starts from the main agent only, with its session's own settings (no tools or agent)")
        const refused = jobsRefusal(origin, "start a detached sub-agent")
        if (refused) return Effect.fail(refused)
        return timers.detach(String(task)).pipe(Effect.mapError((e) => e.message))
      }
      return Effect.gen(function* () {
        const as = agent === undefined ? undefined : yield* loadAgent(agent).pipe(Effect.flatMap((a) => applyAgent(ctx.config, a).pipe(Effect.map((config) => ({ ...a, config })))))
        // Checked and counted together, with nothing in between: spawns made at once (Effect.all) can't all pass the
        // check while an agent loads. Counted once it starts: a refused agent name costs nothing.
        const count = spawned.get(ctx) ?? 0
        if (count >= MAX_SPAWNS_PER_TURN) return yield* Effect.fail(`no more sub-agents this turn (${MAX_SPAWNS_PER_TURN} started): collect the ones running with wait, and do the rest in this kernel or give several items to one sub-agent`)
        spawned.set(ctx, count + 1)
        return yield* ctx.conversation.jobs.spawn(String(task), ctx.spawn(String(task), { tools, agent: as }).pipe(Effect.provideContext(services)))
      }).pipe(Effect.mapError((e) => (typeof e === "object" && e !== null && "message" in e ? String(e.message) : e)))
    },
    wait: (arg: unknown) => {
      const { ids, seconds } = arg as { ids: ReadonlyArray<string>; seconds: number }
      return ctx.conversation.jobs.wait(ids, seconds)
    },
    // A timer's or a detached sub-agent's id goes to the agent (its /cron jobs, the user's and the model's alike), a
    // sub-agent's to this turn's jobs.
    cancel: (id: unknown) => String(id).startsWith(TIMER) || String(id).startsWith(DETACHED) ? Context.get(services, Timers).cancel(String(id)) : ctx.conversation.jobs.cancel(String(id)),
    jobs: () => Context.get(services, Timers).list.pipe(Effect.map((timers) => ({ ...ctx.conversation.jobs.list(), ...timers }))),
    // A reminder ({ at }) or a recurring job ({ cron, tz }) that runs `prompt` as a new turn of this session (src/loop/jobs.ts
    // Timers). Refused in a run that a job or a detached sub-agent started: jobs can't make more jobs (R17).
    schedule: (arg: unknown) => Effect.suspend(() => {
      const timers = Context.get(services, Timers), origin = timers.origin()
      const refused = jobsRefusal(origin, "schedule")
      if (refused) return Effect.fail(new Error(refused))
      return timers.schedule(arg)
    }),
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
      if (!SCOPES.includes(scope)) return `not done: no memory scope "${scope}" (agent, project or user)`
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
    // An agent-written skill (KTD20; src/base/skills.ts saveSkill). From the user's own run it's in the catalog at once, as
    // /skills reload does; from any other (a job, a detached sub-agent, a review, a resume), or with skills.writeApproval
    // on, it's staged for /skills approve.
    saveSkill: (arg: unknown) => Effect.gen(function* () {
      const origin = Context.get(services, Timers).origin() ?? "user"
      const pending = origin !== "user" || ctx.config.skills?.writeApproval === true
      const saved = yield* saveSkill(arg, { pending, home })

      if (!pending) {
        ctx.conversation.skills = discoverSkills(process.cwd(), home)
        ctx.conversation.skillCatalogPending = true
      }
      const warned = saved.flags.length ? `\nScan warnings: ${describeFlags(saved.flags)}` : ""
      return pending
        ? `staged skill ${saved.name}: it waits for the user's approval (/skills pending, /skills approve ${saved.name}) and isn't in the catalog yet: ${saved.path}${warned}`
        : `saved skill ${saved.name} (${saved.created ? "new" : "updated"}): ${saved.path}; in the catalog now: skill({ name: "${saved.name}" })${warned}`
    }).pipe(Effect.mapError((e) => new Error(e.message))),
    // Earlier sessions, searched and read back (src/loop/past.ts); this conversation's own session is left out of searches.
    // Only the fields pastSessions knows, each of its own type, are passed on.
    pastSessions: (arg: unknown) => {
      const a = (arg && typeof arg === "object" ? arg : {}) as Record<string, unknown>
      const mode: PastArgs["mode"] = a.mode === "scroll" || a.mode === "read" ? a.mode : a.mode === undefined || a.mode === "discover" ? "discover" : undefined
      if (!mode) return Effect.fail(new Error("pastSessions mode is discover, scroll or read"))
      if (mode === "discover" && (typeof a.query !== "string" || !a.query.trim())) return Effect.fail(new Error("pastSessions expects a query of words"))

      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
      const args: PastArgs = { mode, query: typeof a.query === "string" ? a.query : undefined, session: typeof a.session === "string" ? a.session : undefined, seq: num(a.seq), window: num(a.window),
        limit: num(a.limit) !== undefined && num(a.limit)! > 0 ? num(a.limit) : undefined, allProjects: a.allProjects === true, summarize: a.summarize === true }
      return pastSessions(args, { cwd: process.cwd(), exclude: ctx.session.key.split("/")[1] }).pipe(Effect.provideContext(services))
    },
    // An image from the configured API (src/base/media.ts), kept with this session's kernel; the cell gets its path.
    image: (arg: unknown) => {
      if (!has(ctx.config.kernel.tools, "media")) return Effect.fail(new Error("image requires the media grant"))
      if (typeof arg !== "string" || !arg.trim()) return Effect.fail(new Error("image expects a prompt"))
      return makeMedia(ctx.config.media).image(arg, `${ctx.session.dir}/kernel/images/${crypto.randomUUID()}.png`).pipe(Effect.mapError((e) => new Error(e.message)))
    },
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
    // Capture successful loads independently of the cell's return value (even if it discards them).
    const skills: string[] = []
    const cellHost = { ...host, skill: (arg: unknown) => host.skill!(arg).pipe(Effect.tap((content) => Effect.sync(() => { skills.push(String(content)) }))) }
    const cell = args.text !== undefined && args.name ? kernel.text(args.name, args.text, args.summary)
      : args.code !== undefined ? kernel.run(args.code, cellHost, args.summary)
      : undefined
    if (!cell) return Effect.succeed("give code (a code cell), or name and text (a text cell)")

    const used = kernelImports(args.code ?? "").filter((n) => trial.includes(n))
    const recordUse = (r: CellResult) => Effect.sync(() => {
      for (const tool of used) record(libraryDir(process.cwd()), { session: ctx.session.id, turn, tool, for: "systemTwo", event: "used", ok: r.status === "ok" })
    })
    return cell.pipe(Effect.tap(recordUse), Effect.map((r) => [describeCell(r), ...(skills.length ? [KERNEL_PASSTHROUGH, ...skills] : [])].join("\n")), Effect.catch((e) => Effect.succeed(`the kernel failed: ${e}`)), Effect.provideContext(services))
  }
}
