import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { emit } from "../base/events"
import { type Cell, type HostFunctions } from "../kernel/kernel"
import { Kernel } from "../tools/kernel-service"
import { Reviewer } from "../learning/reviewer"
import { makeHost } from "./kernel"
import { libraryDir, loadLibrary, loadPool, promote, TSC, withScratch, writeBuiltins } from "./library"
import { record } from "./pool"
import { kernelSources } from "./sources"
import { type Ctx, type Needs, timed, type TurnState } from "./turnkit"

// Adoption, part 2: after a turn, System Two looks back (a separate call, in the background).
// For each tool on trial this turn: did it help (or why wasn't it used)? That verdict goes into the record, where the
// sampler can use it as the reward. And: what did it write this turn that could be a general tool? Each proposal is
// run in a fresh kernel and goes through promote's checks into the pool.

// A session's kernel cells so far (System Two's), from its index.
export const kernelCells = (sessionDir: string): ReadonlyArray<Cell> => {
  const index = join(sessionDir, "kernel", "index.json")
  try { return existsSync(index) ? JSON.parse(readFileSync(index, "utf8")) : [] } catch { return [] }
}

export const Answer = Schema.Struct({
  // applied: the tool was for this kind of request (whether or not it was used); offers where it wasn't don't count.
  tools: Schema.Array(Schema.Struct({ name: Schema.String, applied: Schema.Boolean, helped: Schema.Boolean, why: Schema.String })),
  proposals: Schema.Array(Schema.Struct({
    name: Schema.String,
    for: Schema.Literals(["systemOne", "systemTwo"]),
    description: Schema.String,
    example: Schema.String,
    // A System One tool's parameters (an array, not a record: a strict schema needs fixed keys); none for helpers
    parameters: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String })),
    code: Schema.String,
    why: Schema.String,
  })),
})

// Both kinds of tool are asked for (user, 2026-09-29), each with its own limit: a System One tool for the request itself (it
// can be one even if the agent answered by reading files: that's how later turns skip System Two), and helpers
// abstracted from the code the agent ran.
export const instructions = (max: number, mode: "eager" | "conservative") => [
  "You look back at finished turns of a coding agent (empty-vessel), one or several (refine sends a batch, each turn under its own heading; \"this turn\" below means any of them): the goal, the TypeScript cells it ran in its kernel (maybe none: it may have answered from files it was given), and its answer.",
  "1. tools: for each tool on trial listed, one entry. applied: true if the tool was for this kind of request at all (whether or not it was used). helped: true only if it was used and did what was needed. why: if it applied but wasn't used, why not (e.g. unclear description, the agent's own command was simpler).",
  "2. proposals, two kinds, considered separately:",
  mode === "eager"
    ? `- A System One tool for the request itself (for: "systemOne"), at most ${max}: could this request, asked again in other words, be answered by a tool on its own, computing the answer from the project (a count, a list, a lookup), without an LLM? Propose it even if the agent answered by reading files. Not for requests that need judgment or change code.`
    : `- A System One tool for the request itself (for: "systemOne"), at most ${max}: only if this kind of request will clearly be asked again and a tool can compute the whole answer from the project.`,
  mode === "eager"
    ? `- Helpers (for: "systemTwo"), at most ${max}: abstract the code the agent ran into the general, parameterized version (e.g. a parser written for these files becomes listExports(dir)), when a general version could plausibly be used again. None if it ran no code.`
    : `- Helpers (for: "systemTwo"), at most ${max}: only for code that will clearly be needed again.`,
  "Don't propose what the library or pool already has. Tools go on trial and are dropped if unused, so a reasonable guess is fine; empty lists are fine.",
  "Each proposal is one self-contained TypeScript cell: it imports only from \"kernel\" (Effect and empty-vessel's built-ins: read, readText, write, edit, bash, …), nothing from earlier cells, and exports one const named like the proposal. The kernel's rules apply: the top level only defines things; side effects only through the built-ins (no Bun, node: modules, fetch, process, timers, Date.now, Math.random).",
  "A System One tool returns the answer as text; System One, a fast model, picks it for matching requests. The next request of this kind will be about something else (another file, name, number) and worded differently: declare what varies as parameters (a camelCase name and a description saying what it is, e.g. { name: \"customer\", description: \"the customer's id, e.g. c_1042\" }), and write the tool as a function of one object of those strings: export const x = ({ customer }: { customer: string }) => Effect.gen(…). Each request's values are filled in for it by a model, however it's worded: never parse the request text, never write this request's value into the code. With nothing that varies, no parameters: it takes the request as a string and may ignore it. If what a parameter names doesn't exist, it fails (Effect.fail with why), never returns a message such as \"please specify…\" as if it were the answer. A helper takes whatever arguments suit it and has no parameters listed.",
  "The built-ins return Effects: use them inside Effect.gen with yield* (const text = yield* readText(path)), not as plain values. bash(command) gives one string, \"exit N\" on its first line and the output after it (no .stdout or .exitCode).",
  "description: what it answers or does, how to call it, and which close requests it doesn't answer (they would be mistaken for it). example: a request it answers (systemOne) or a call such as grepSource(\"TODO\") (systemTwo); it's run once as a check.",
].join("\n")

// This turn's cells, as System Two wrote them (imports from "kernel", not from the scope file they were saved with).
const turnCells = (ctx: Ctx, state: TurnState) =>
  kernelCells(ctx.session.dir).filter((c) => c.n > state.cellsBefore).map((c) => {
    const code = readFileSync(join(ctx.session.dir, "kernel", `cell-${c.n}.ts`), "utf8").replace(/(["'])\.\/scope-\d+\.ts\1/g, `"kernel"`)
    return `cell ${c.n} (${c.status}):\n${code.slice(0, 3000)}`
  })

// Proposed tools: each cell runs in a fresh kernel (with the library's built-ins), then promote checks it (it runs on
// its example, System One grades its description) into the pool. Returns one line per proposal.
export const proposeTools = (dir: string, from: string, host: HostFunctions, proposals: ReadonlyArray<typeof Answer.Type["proposals"][number]>) =>
  Effect.forEach(proposals, (p) =>
    withScratch("empty-vessel-proposal-", (kernelDir) => Effect.gen(function* () {
      const cell = yield* (yield* Kernel).open({ dir: kernelDir, builtins: writeBuiltins(join(kernelDir, "builtins.ts"), dir), tsc: TSC, sources: kernelSources() }).run(p.code, host)
      const said = cell.status === "ok"
        ? yield* promote(dir, kernelDir, from, host, { name: p.name, description: p.description, example: p.example, for: p.for, parameters: Object.fromEntries(p.parameters.map((x) => [x.name, x.description])) }, "pool")
        : `not proposed: its cell failed (${cell.status}): ${cell.summary.slice(0, 300)}`
      // All of it on one line: why a proposal was refused is on the lines after the first (the rubric's failures).
      return `${p.name} (${p.for}): ${said.split("\n").filter(Boolean).join(" ").slice(0, 600)}`
    })))

// When: "whenSystemTwoRan" (every turn it answered: even without code, the request may make a System One tool),
// "whenSomethingToJudge" (only if tools were on trial or it ran cells: cheaper), "always", or "never".
export const shouldAsk = (ctx: Ctx, state: TurnState) => {
  if (ctx.config.systemTwo.use === "fake") return false // no System Two to ask
  const when = ctx.config.adoption.askAtEndOfTurn
  const something = state.offered.systemOne.length + state.offered.systemTwo.length > 0 || kernelCells(ctx.session.dir).length > state.cellsBefore
  return when === "always" || (when === "whenSystemTwoRan" && state.escalated > 0) || (when === "whenSomethingToJudge" && state.escalated > 0 && something)
}

export const askAfterTurn = (ctx: Ctx, state: TurnState, reply: string) =>
  Effect.gen(function* () {
    const dir = libraryDir(process.cwd())
    const pool = loadPool(dir)
    const offered = pool.filter((e) => state.offered[e.for].includes(e.name))
    const turn = state.turn

    const digest = [
      `Goal: ${ctx.input}`,
      `Tools on trial this turn:\n${offered.map((e) => `- ${e.name} (for ${e.for === "systemOne" ? "System One" : "the agent"}): ${e.description}`).join("\n") || "(none)"}`,
      `Tools already in the library: ${loadLibrary(dir).map((e) => e.name).join(", ") || "none"}`,
      `Tools already on trial in the pool: ${pool.map((e) => e.name).join(", ") || "none"}`,
      `The agent's cells this turn:\n\n${turnCells(ctx, state).join("\n\n") || "(none)"}`,
      `Answer: ${reply.slice(0, 2000)}`,
    ].join("\n\n")

    const { result: { value } } = yield* timed(ctx, "systemTwo", (yield* Reviewer).ask(instructions(ctx.config.adoption.maxProposals, ctx.config.adoption.proposals), Answer, digest))

    // Verdicts: only for tools that really were on trial.
    for (const v of value.tools) {
      const e = offered.find((o) => o.name === v.name)
      if (e) record(dir, { session: ctx.session.id, turn, tool: e.name, for: e.for, event: "verdict", applied: v.applied, helped: v.helped, why: v.why })
    }

    const max = ctx.config.adoption.maxProposals
    const chosen = [...value.proposals.filter((p) => p.for === "systemOne").slice(0, max), ...value.proposals.filter((p) => p.for === "systemTwo").slice(0, max)]
    const results = yield* proposeTools(dir, ctx.session.id, makeHost(ctx, yield* Effect.context<Needs>()), chosen)

    yield* ctx.session.record("review", "adoption", { verdicts: value.tools, proposals: value.proposals, results })
    yield* emit("review", ctx.depth, `adoption: ${value.tools.map((v) => `${v.name} ${v.helped ? "helped" : v.applied ? "applied, not used" : "didn't apply"}`).join(", ") || "no tools on trial"}` +
      `${results.map((r) => `\n  proposed ${r}`).join("")}`)
  }).pipe(Effect.catch((e) => emit("error", ctx.depth, `adoption's end-of-turn questions failed: ${e}`)))
