import { Context, Effect, Layer, Schema } from "effect"
import { ALL, type Grants, has, type Need } from "../base/grants"
import type { Tokens } from "../base/usage"
import type { SessionMirrorFn } from "../base/session"
import { Question } from "../ui/ask"

// Structured questions: reuse the UI schema so the model and the picker agree.
export const AskUserArgs = Schema.Struct({
  questions: Schema.Array(Question).pipe(Schema.check(Schema.isMinLength(1))).annotate({
    description: "One or more questions, each with 1–3 suggested options; the user can also type their own answer",
  }),
})
export const ASK_USER_DESCRIPTION =
  "Ask the user interactive questions with suggested options and receive their answers directly. " +
  "Use this when you need a choice before continuing; the user can also type a custom answer."

// Pause this turn for a human response without claiming the task is complete.
export const WaitForUserArgs = Schema.Struct({
  message: Schema.String.annotate({ description: "The question or checkpoint to show the user before pausing" }),
})
// Output System One shortened (pruning, compaction) comes back by the id it gave.
export const MoreOutputArgs = Schema.Struct({
  id: Schema.String.annotate({ description: "The id System One gave, e.g. out1" }),
})
export const MORE_OUTPUT_DESCRIPTION = "Show the full output of an earlier command whose output System One shortened (it says so, with an id)"
export const WAIT_FOR_USER_DESCRIPTION =
  "Pause and return control to the user when you need their answer before continuing, including required quiz checkpoints. " +
  "Send the full user-facing message. This ends the current turn, not the task; it does not claim completion."
// A note to the user while the work goes on: progress on long work, or a step only they can do.
export const TellUserArgs = Schema.Struct({
  message: Schema.NonEmptyString,
  file: Schema.optionalKey(Schema.NonEmptyString.annotate({
    description: "Local file path to send as an attachment; message becomes its caption. Main agent only; waits for delivery and reports failure if unsupported.",
  })),
})
export const TELL_USER_DESCRIPTION =
  "Tell the user something now and keep working (it doesn't end your turn): a short progress note at milestones of long work, " +
  "or, as soon as you find it, a step only they can do (a secret or credential, an account or service setting, an approval, a domain). " +
  "Optionally provide file, a local file path, to send an attachment with message as its caption. " +
  "Attachment delivery is main-agent only and awaited; unsupported channels or failed sends return an error."

// System Two hands a pass/fail check to System One: the command, whether a pass means the whole goal is done
// (only System Two knows its plan), what to tell the user then, and (optionally) what to tell them if it fails.
export const YieldArgs = Schema.Struct({
  command: Schema.optionalKey(Schema.String.annotate({ description: "Shell command whose output shows pass or fail, e.g. bun test (or use check)" })),
  check: Schema.optionalKey(Schema.Struct({
    name: Schema.String.annotate({ description: "The name of a saved check listed in your instructions" }),
    args: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({ description: "A value for each {slot} in its template; a list for several arguments" }),
  }).annotate({ description: "Run a saved check instead of writing the command" })),
  finishes: Schema.Boolean.annotate({ description: "true if this check passing means the whole goal is done; false for an in-between check" }),
  success: Schema.optionalKey(Schema.String.annotate({ description: "Your final answer to the user if the check passes and finishes is true. You write it before the check runs, so don't state its result (counts, timings): its output is shown under your answer" })),
  save_as: Schema.optionalKey(Schema.Struct({
    name: Schema.String.annotate({ description: "Short name, e.g. tests-for" }),
    description: Schema.String.annotate({ description: "When to use it, e.g. Run the tests for one dayjs plugin" }),
    template: Schema.String.annotate({ description: "The command with {slots} for the parts that change, e.g. npx jest test/plugin/{plugin}.test.js --runInBand" }),
    args: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({ description: "This run's value for each slot, e.g. { plugin: duration }; a list for several arguments, e.g. { files: [a.test.js, b.test.js] }" }),
    scope: Schema.Literals(["project", "general"]).annotate({ description: "project: tied to this repo's layout; general: works in any project of this kind" }),
    requires: Schema.optionalKey(Schema.Array(Schema.String).annotate({ description: "general only: files that must exist for it to apply, e.g. pnpm-lock.yaml" })),
  }).annotate({ description: "If you'd reuse this command in later tasks, save it: it's kept only if the check passes" })),
  failure: Schema.optionalKey(Schema.String.annotate({ description: "Your final answer to the user if the check fails. Leave out to get the output back and keep working" })),
})
export const YIELD_DESCRIPTION =
  "Hand a clear pass/fail check to System One (a fast, cheap judgment model that runs commands and reads their output, " +
  "but cannot write code). System One runs the command and decides pass or fail. The way to finish a task: the check that shows it's done, finishes=true, and your final answer in success. " +
  "Pass with finishes=true: your success message goes to the user and the task ends, with no further round for you (if System One isn't sure of the pass, you get the output back to answer yourself). " +
  "Pass with finishes=false: you get the output back and keep working. " +
  "Fail: your failure message goes to the user, or, if you gave none, you get the output back to keep working."
// The kernel: System Two's one tool for doing work. Each call runs a TypeScript cell.
// Optional for old callers; new LLM calls should supply a concise intent for every cell.
export const CellSummary = Schema.String
export const KernelArgs = Schema.Struct({
  summary: Schema.optionalKey(CellSummary.annotate({ description: "Summarize this cell’s intent concisely. Aim for 1–6 words, e.g. Read TUI renderer or Check notebook click targets. Supply for every code and text cell. Used as its display title and saved for future context/compaction; do not claim a result before execution." })),
  code: Schema.optionalKey(Schema.String.annotate({ description: "A code cell: a TypeScript module. Import what you need from \"kernel\". Its top level only defines things (no work, no await); named exports are definitions kept for later cells; the default export is the action, run once (an Effect, a function or a value), and its value comes back as $N" })),
  name: Schema.optionalKey(Schema.String.annotate({ description: "A text cell's name (letters, digits, _), e.g. reportPy: later code cells import it from \"kernel\" as a string" })),
  text: Schema.optionalKey(Schema.String.annotate({ description: "A text cell: any text kept exactly as given (Python, Markdown, a prompt, a rubric, a template), never escaped into TypeScript. Give name too" })),
})
// The kernel tool's description, naming only the built-ins `g` grants (src/base/grants.ts); with everything granted,
// exactly the text from before grants.
const DESCRIBED_FILES: ReadonlyArray<readonly [Need, string]> = [
  ["read", "read(path, offset?, limit?)"], ["read", "readText(path)"], ["read", "skill({ name, arguments? }) (load skill instructions; never executes them)"], ["write", "write(path, content)"], ["write", "edit(path, [{ oldText, newText }])"], ["shell", "bash(command, timeoutSeconds?)"],
]
const DESCRIBED_OTHERS: ReadonlyArray<readonly [Need | undefined, string]> = [
  [undefined, "now()"], [undefined, "random()"],
  ["systemOne", "judge(items, evidence, questions) (System One answers the same named multiple-choice questions for every item, an LLM re-checks the doubtful ones; the way to classify, match or rate many items)"],
  ["systemOne", "systemOne(evidence, questions) (one System One call)"],
  ["agents", "spawn(task) (starts a sub-agent for work that needs its own reasoning; returns its job id at once)"], ["agents", "wait(ids) / cancel(id) / jobs() (collect or drop sub-agents)"],
  [undefined, "remember(effect or (input) => effect) (saved and reused by later cells: for System One, judge, sub-agents, tool sources)"], [undefined, "result(n) (an earlier cell's value)"],
  [undefined, "and every earlier cell's definitions"],
]
export const kernelDescription = (g: Grants = ALL, missing: ReadonlyArray<string> = []) => {
  const files = DESCRIBED_FILES.filter(([n]) => has(g, n)).map(([, t]) => t)
  const others = DESCRIBED_OTHERS.filter(([n]) => !n || has(g, n)).map(([, t]) => t)
  return `Run a TypeScript cell in the kernel. From "kernel" import Effect (and the rest of effect) and the built-ins: ${[...(files.length ? [`${files.join(", ")} (each an Effect returning text)`] : []), ...others].join(", ")}. ` +
    (missing.length ? `Not in this kernel: ${missing.join("; ")}. ` : "") +
    "Include summary with every cell. Aim for 1–6 words describing its intent, not its outcome. " +
    "The top level only defines things; side effects only through the built-ins (no Bun, node:, fetch, process, timers, Date.now, Math.random). " +
    "Include summary with every cell. Aim for 1–6 words describing its intent, not its outcome. " +
    "Named exports stay defined for later cells; the default export is run once and its value comes back shortened as $N. console.log output comes back too. Rule breaks and type errors come back before it runs. " +
    `Or a text cell: { name, text } defines name as that text, exactly (for Python, Markdown, prompts, rubrics: anything that isn't TypeScript); use it from a later code cell${has(g, "write") ? ", e.g. write(\"work/report.py\", reportPy)" : ""}.`
}
export const KERNEL_DESCRIPTION = kernelDescription(ALL)

// What System One decided: a final answer for the user (done: the goal is finished), or output for System Two to keep working with.
export type ToolCall = { readonly tool: string; readonly args: unknown; readonly output: string }
// System One's parts of System Two's run, passed in by `turn`: the yield check, hearing every tool call (for the
// session), and shortening long command output before System Two sees it (the full output stays available).
export type Hooks = {
  // Interactive answers return to the current model call instead of ending the turn.
  readonly askUser?: (args: typeof AskUserArgs.Type) => Effect.Effect<string>
  readonly handoff?: (args: typeof YieldArgs.Type) => Effect.Effect<Handoff>
  readonly onCommand?: (c: ToolCall) => Effect.Effect<void>
  readonly prune?: (command: string, output: string) => Effect.Effect<string>
  // Run a kernel cell: System Two's one tool for work (reading, editing, commands, judge, sub-agents are its built-ins).
  readonly kernel?: (args: typeof KernelArgs.Type) => Effect.Effect<string>
  // System Two's conversation so far (its own format), appended to by every run: one per session, like Pi's.
  // Without it, each run starts fresh with only the new prompt.
  readonly thread?: Array<unknown>
  // What the loop hands over with every request: the project's instructions (AGENTS.md / CLAUDE.md), then what empty-vessel
  // learned about the project (notes, saved checks). The same all session. Backends add it to their own instructions.
  readonly briefing?: string
  // Durable skill state for providers that compact their own sessions; refreshed at each provider run.
  readonly skillContext?: () => string
  // Images in the user's message (paths that exist), for System Two to look at: sent with this run's prompt.
  readonly images?: ReadonlyArray<{ readonly label: string; readonly path: string }>
  // Outputs System One hid (shortened or compacted), by id, so more_output can bring them back. One per session.
  readonly stash?: Map<string, string>
  // The prompt-cache key: the session id, so a resumed session reuses the cache it built before.
  readonly cacheKey?: string
  // How deep the agent is (0 = the root, 1 = a sub-agent, …), so what System Two does shows at the right level.
  readonly depth?: number
  // Sub-agent jobs System Two started and hasn't collected yet; its run can't finish while there are any.
  readonly pending?: () => ReadonlyArray<string>
  // What the user typed while this run works (steering), handed over once each: delivered with the next tool result,
  // or before the next request if System Two was answering (src/base/inbox.ts). None: nothing comes in mid-run.
  readonly inbox?: Effect.Effect<ReadonlyArray<string>>
  // Every so often with no tell_user, a tool result reminds System Two to send a progress note (ms; none: never).
  readonly progressEveryMs?: number
  // After each tool call: a note if the run's changes reached a part of the project outside where it started (another
  // package, src/loop/scope.ts), telling System Two to ask the user first; none: no check.
  readonly scope?: () => Effect.Effect<string | undefined>
  // What empty-vessel remembers now (the memory snapshot): a setup lesson already in it isn't suggested again. None: lessons
  // aren't suggested (no memory to save them in).
  readonly remembered?: () => Effect.Effect<string>
  // What the kernel grants (config.json's kernel.tools): System Two's instructions and the kernel tool name only those
  // built-ins (kernelInstructions, systemTwoTools). None: everything.
  readonly grants?: Grants
}

// How to compact: System One's scores for old tool outputs ("still needed?", 0–1), where hidden outputs go, the thread's
// size now, and the size to get under (a summary is written only if hiding outputs isn't enough).
export type CompactOptions = {
  readonly score: (labels: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<number>>
  readonly stash: Map<string, string>
  readonly size: number
  readonly target: number
}
type Compacted = { readonly masked: number; readonly savedTokens: number; readonly summarized: number; readonly after: number; readonly tokens: Tokens }
export type Handoff = { readonly answer: string; readonly done: boolean } | { readonly output: string }

// System Two: slow, expensive reasoning (the LLM). Only called when System One escalates.
export class SystemTwo extends Context.Service<
  SystemTwo,
  {
    // Optional compatibility log, scoped to this provider’s turns (including System One’s steps).
    readonly sessionMirror?: SessionMirrorFn
    // `size`: the input tokens of its last request, i.e. how big the thread is now.
    readonly ask: (prompt: string, hooks?: Hooks) => Effect.Effect<{ text: string; tokens: Tokens; done?: boolean; waitingForUser?: boolean; size?: number }>
    // Shrink the thread in place: hide old tool outputs System One says aren't needed, then (if still too big) summarize.
    readonly compact: (thread: Array<unknown>, options: CompactOptions) => Effect.Effect<Compacted>
  }
>()("empty-vessel/SystemTwo") {}

// Fake System Two: pretends to think. The real LLM will be another Layer with the same shape.
export const FakeSystemTwo = Layer.succeed(SystemTwo, {
  ask: (prompt) => Effect.succeed({ text: `(System Two would think about: "${prompt}")`, tokens: { input: 0, output: 0 } }),
  compact: (_thread, { size }) => Effect.succeed({ masked: 0, savedTokens: 0, summarized: 0, after: size, tokens: { input: 0, output: 0 } }),
})
