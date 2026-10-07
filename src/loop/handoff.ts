import { Effect } from "effect"
import { emit } from "../base/events"
import { Kernel } from "../tools/kernel-service"
import { fillTemplate, recordUse, saveCheck, type Scoped, vetCheck } from "../learning/checks"
import { shownAs } from "../system-two/dispatch"
import type { Handoff, ToolCall, YieldArgs } from "../system-two/systemtwo"
import { type Ctx, timed, type TurnState } from "./turnkit"

// What System One decides when System Two yields a check to it.
const CHECK = {
  passed: "The check succeeded: e.g. every test passes, exit code 0, no errors",
  failed: "The command ran and reported problems: failing tests, errors in the code",
  broken: "The command itself didn't run: command not found, bad arguments, missing file, no tests matched",
}

type Args = typeof YieldArgs.Type

// Which command to run: a saved check by name (code fills its template, each argument quoted), or System Two's own
// command. A problem (unknown name, missing argument, nothing given) goes back to System Two as text.
export const resolveCommand = (args: Args, checks: ReadonlyArray<Scoped>): { command: string; saved?: Scoped } | { problem: string } => {
  if (!args.check) return args.command ? { command: args.command } : { problem: "Give a command, or a saved check with its args." }

  const saved = checks.find((c) => c.name === args.check!.name)
  if (!saved) return { problem: `No saved check is named "${args.check.name}". Saved: ${checks.map((c) => c.name).join(", ") || "none"}` }

  const filled = fillTemplate(saved.template, args.check.args)
  return filled.missing ? { problem: `Check "${saved.name}" needs a value for: ${filled.missing.join(", ")}` } : { command: filled.command!, saved }
}

// System One's verdict, or, if System One couldn't judge (its fallback isn't a verdict), what code knows for certain: the
// exit code. A pass needs exit 0 as well: System One reading "passed" into a failing command's output isn't a pass.
const exitedOk = (output: string) => /^exit 0\n/.test(output)
export const verdictOf = (choice: string, output: string) =>
  choice === "passed" && !exitedOk(output) ? "failed" : choice in CHECK ? choice : exitedOk(output) ? "passed" : "failed"

// How sure System One must be of a pass to end the turn for System Two; below it, the output goes back and System Two
// answers itself. ponytail: fixed; Jev at 0.95 and up is almost always right (kernel instructions), tune from the logs.
const SURE = 0.8

// The end of a check's output (where test runners put their totals), shown under a finishing answer.
const tail = (output: string, lines = 12, chars = 1200) => output.trim().split("\n").filter((l) => l.trim()).slice(-lines).join("\n").slice(-chars)

// What System Two gets back. A pass ends the turn only if System Two said this check finishes the goal and System One
// judged it itself, surely: then System Two's answer goes to the user without another model round. System Two wrote
// that answer before the check ran, so the check's own output goes with it: what it says about the result (a test
// count) can be wrong (the recurring-requests benchmark: "12 tests pass" where 7 did); the output can't.
export const replyFor = (verdict: string, args: Args, command: string, output: string, sure = true): Handoff => {
  if (verdict === "passed" && args.finishes && sure)
    return { answer: `${args.success ?? "Done."}\n\n\`${command}\` passed:\n\`\`\`\n${tail(output)}\n\`\`\``, done: true }
  if (verdict === "passed") return { output: `System One judged this a pass${args.finishes ? ", but not surely enough to finish for you: read the output and answer" : ""}.\n${output}` }
  if (args.failure !== undefined) return { answer: args.failure, done: false }
  return { output: `System One judged this ${verdict === "broken" ? "broken (the command itself didn't run)" : "a failure"}.\n${output}` }
}

// Run the check and have System One judge it from the end of its output.
const judge = (ctx: Ctx, command: string) =>
  Effect.gen(function* () {
    const output = yield* (yield* Kernel).exec(command, 120_000) // where the cells' files are
    const { result: pick, ms } = yield* timed(ctx, "systemOne", ctx.systemOne.choose({ goal: `Did this check pass? ${command}`, steps: [`${command} → ${output.slice(-300)}`] }, CHECK))
    return { output, verdict: verdictOf(pick.choice, output), judged: pick.choice in CHECK, confidence: pick.confidence, ms }
  })

type Judged = Effect.Success<ReturnType<typeof judge>>

// Show it, and keep it in the turn and the session: the reviewer looks for repeated commands and failures.
const recordCheck = (ctx: Ctx, state: TurnState, command: string, finishes: boolean, j: Judged) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`system one check (${Math.round(j.ms)} ms) ${JSON.stringify({ command, choice: j.verdict, confidence: j.confidence, output: j.output.slice(0, 8000) })}`)
    yield* emit("check", ctx.depth, `  system one checked: ${command} → ${j.verdict} (${j.judged ? j.confidence.toFixed(2) : "exit code: System One didn't answer"})`)

    state.work.push(`check ${command} → ${j.verdict}`)
    state.did.push(`check ${command.length > 60 ? `${command.slice(0, 60)}…` : command} → ${j.verdict}`)
    if (j.verdict === "passed") state.passed.push(command)
    yield* ctx.session.record("check", command, { verdict: j.verdict, confidence: j.confidence, finishes, output: j.output.slice(-500) }).pipe(Effect.ignore)
  })

// Learning from the check: save a passing one System Two wants to reuse (if code's checks allow it: the maker isn't
// the checker), and count a saved check's use (pass, or broken).
const keepCheck = (ctx: Ctx, args: Args, command: string, verdict: string, saved: Scoped | undefined) =>
  Effect.gen(function* () {
    if (verdict === "passed" && args.save_as) {
      const refused = vetCheck(args.save_as, command, process.cwd())
      if (!refused) yield* saveCheck(process.cwd(), args.save_as, `save_as in session ${ctx.session.id}`)
      yield* emit("check", ctx.depth, `  ${refused ? `not saved (${refused})` : `saved check ${args.save_as.name} (${args.save_as.scope})`}: ${args.save_as.template}`)
    }

    if (saved) {
      yield* recordUse(process.cwd(), saved, verdict)
      yield* emit("check", ctx.depth, `  used saved check ${saved.name} (${saved.scope})`)
    }
  })

// yield_to_system_one: System One runs System Two's check and decides pass or fail.
// `checks`: the saved checks System Two may name (it sees the same list in its instructions).
export const makeHandoff = (ctx: Ctx, state: TurnState, checks: ReadonlyArray<Scoped>) => (args: Args): Effect.Effect<Handoff> =>
  Effect.gen(function* () {
    const which = resolveCommand(args, checks)
    if ("problem" in which) return { output: which.problem }
    // No shell in this kernel means no commands at all: a check is a command, so it would be bash by another door.
    if (!ctx.config.kernel.tools.shell) return { output: "This kernel has no shell (kernel.tools.shell is off): System One can't run commands for you either. Check the work another way (read the files), then answer." }

    const j = yield* judge(ctx, which.command)
    yield* recordCheck(ctx, state, which.command, args.finishes, j)
    yield* keepCheck(ctx, args, which.command, j.verdict, which.saved)

    // When System Two meant this check to finish the task: which way it went (ended here, or back to System Two).
    const reply = replyFor(j.verdict, args, which.command, j.output, j.judged && j.confidence >= SURE)
    if (args.finishes) {
      const ended = "done" in reply && reply.done === true
      yield* Effect.logDebug(`system one finish ${JSON.stringify({ command: which.command, ended, verdict: j.verdict, confidence: j.confidence })}`)
      yield* emit("check", ctx.depth, ended ? "  → finished: System Two's answer goes to you, no more model rounds" : `  → not finished (${j.verdict === "passed" ? "a pass, but System One isn't sure" : j.verdict}): back to System Two`)
    }
    return reply
  })

// Every System Two command goes in the session too (the end of its output, where the verdict usually is).
export const makeOnCommand = (ctx: Ctx, state: TurnState) => (c: ToolCall) =>
  Effect.gen(function* () {
    state.work.push(`${shownAs(c.tool, c.args)} → ${c.output.slice(-150)}`)

    yield* ctx.session.record("command", c.tool, { args: c.args, output: c.output.slice(-500) }).pipe(Effect.ignore)
  })
