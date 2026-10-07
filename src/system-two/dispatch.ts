import { Effect, Option, Schema } from "effect"
import { emit } from "../base/events"
import { exitOf, lessonIn } from "../base/lessons"
import { Delivery, deliveryError } from "../base/delivery"
import { ALL, allGranted, type Grants } from "../base/grants"
import { jsonSchemaFor } from "../base/json-schema"
import { notGranted } from "./instructions"
import {
  ASK_USER_DESCRIPTION, AskUserArgs, CellSummary, type Hooks, KERNEL_DESCRIPTION, KernelArgs, kernelDescription, MORE_OUTPUT_DESCRIPTION, MoreOutputArgs,
  TELL_USER_DESCRIPTION, TellUserArgs, WAIT_FOR_USER_DESCRIPTION, WaitForUserArgs, YIELD_DESCRIPTION, YieldArgs,
} from "./systemtwo"

// System Two's tool calls, handled the same for every backend (Codex's request loop, claude -p's MCP relay): check the
// arguments, call empty-vessel's hook, show and record the call, shorten long output. Each backend keeps only how calls
// reach it and how results go back (Codex: function-call items in its thread; Claude: a socket reply).

// A call that ended the run: a finishing check passed (or failed with an answer for the user), or it waits for the user.
export type Ended = { readonly answer: string; readonly done: boolean; readonly waitingForUser?: boolean }
// A run's state, shared by its calls: whether System One still shortens long output (not after a more_output: its
// guess was wrong once), the full text of what it shortened, by id, and when the user last heard from it (the run's
// start, then each tell_user or progress reminder), by `now` (a clock tests can set).
// `failed`: this run's commands that failed, and `lessons`: the setup lessons already suggested (lessonNote).
export type CallState = { pruning: boolean; readonly stash: Map<string, string>; told: number; readonly now: () => number; readonly failed: Array<string>; readonly lessons: Set<string> }

export const newCallState = (stash: Map<string, string> = new Map(), now = Date.now): CallState => ({ pruning: true, stash, told: now(), now, failed: [], lessons: new Set() })

// The tools System Two is given, for any backend to present its own way (Codex: function definitions; claude -p: an
// MCP server's tool list): each one's name, what System Two is told about it, and its arguments as JSON schema. The
// kernel's description names only the built-ins `g` grants (hooks.grants: the kernel this run's cells go to).
export const systemTwoTools = (g: Grants = ALL) => [
  { name: "kernel", description: allGranted(g) ? KERNEL_DESCRIPTION : kernelDescription(g, notGranted(g)), parameters: jsonSchemaFor(KernelArgs) },
  { name: "yield_to_system_one", description: YIELD_DESCRIPTION, parameters: jsonSchemaFor(YieldArgs) },
  { name: "more_output", description: MORE_OUTPUT_DESCRIPTION, parameters: jsonSchemaFor(MoreOutputArgs) },
  { name: "ask_user", description: ASK_USER_DESCRIPTION, parameters: jsonSchemaFor(AskUserArgs) },
  { name: "wait_for_user", description: WAIT_FOR_USER_DESCRIPTION, parameters: jsonSchemaFor(WaitForUserArgs) },
  { name: "tell_user", description: TELL_USER_DESCRIPTION, parameters: jsonSchemaFor(TellUserArgs) },
] as const
export const SYSTEM_TWO_TOOLS = systemTwoTools(ALL)

export const PRUNE_OVER = 8_000 // characters (~2k tokens): shorter output isn't worth a System One call

// The arguments checked against the tool's schema (a problem goes back as text), then the hook run.
export const viaHook = <S extends Schema.Top & { readonly DecodingServices: never }>(name: string, schema: S, hook: ((args: S["Type"]) => Effect.Effect<string>) | undefined, parsed: unknown) =>
  Schema.decodeUnknownEffect(schema)(parsed).pipe(
    Effect.matchEffect({
      onFailure: (e) => Effect.succeed(`invalid arguments for ${name}: ${e.message}`),
      onSuccess: (args) => (hook ? hook(args) : Effect.succeed(`${name} isn't available here (too deep for sub-agents)`)),
    }),
  )

// A cell's title: its code without the import statements, first line (e.g. "export default bash('cat money.ts')").
export const codeTitle = (code: string) =>
  code.replace(/import\s[^;]*?from\s*["'][^"']*["'];?/g, "").split("\n").find((l) => l.trim())?.trim().slice(0, 100) ?? "(empty cell)"

const cellSummary = (name: string, parsed: any) => {
  const decoded = Schema.decodeUnknownOption(CellSummary)(parsed?.summary)
  return name === "kernel" && Option.isSome(decoded) ? decoded.value : undefined
}

// How a tool call is shown: a kernel cell by its title (a text cell by its name); any other tool by name.
export const shownAs = (name: string, parsed: any) =>
  name === "kernel" ? (parsed?.text !== undefined ? `kernel: text ${parsed?.name ?? "(no name)"} (${String(parsed.text).split("\n").length} lines)` : `kernel: ${cellSummary(name, parsed) ?? codeTitle(String(parsed?.code ?? ""))}`)
  : name

// What can be unfolded under it: a cell's code (or text) and its result.
// ponytail: output capped at its last 200 lines for the screen (the session file keeps all of it).
export const bodyOf = (name: string, parsed: any, output: string) => {
  const tail = output.split("\n").slice(-200).join("\n")
  return name === "kernel" ? `${String(parsed?.code ?? parsed?.text ?? "")}\n── result ──\n${tail}` : undefined
}

// "What's happening now", for a live display: every call but a check (System One shows its own line for those).
export const showActivity = (name: string, parsed: unknown, hooks: Hooks) =>
  name === "yield_to_system_one" ? Effect.void : emit("activity", hooks.depth ?? 0, `running ${shownAs(name, parsed).split("\n")[0]}`, undefined, cellSummary(name, parsed))

// System Two's tools. `undefined` for a tool this doesn't know.
export const runTool = (name: string, parsed: any, hooks: Hooks, state: CallState): Effect.Effect<{ output: string } | Ended | undefined> =>
  Effect.gen(function* () {
    if (name === "ask_user") {
      const decoded = Schema.decodeUnknownOption(AskUserArgs)(parsed)
      if (Option.isNone(decoded)) return { output: "invalid arguments: provide questions with 1–3 nonempty options each" }
      if (!hooks.askUser) return { output: "Interactive questions are only available to the main agent." }

      return { output: yield* hooks.askUser(decoded.value) }
    }

    if (name === "wait_for_user") {
      const decoded = Schema.decodeUnknownOption(WaitForUserArgs)(parsed)
      if (Option.isNone(decoded)) return { output: "invalid arguments: provide a message for the user" }
      if (hooks.pending?.().length) return { output: "Collect or cancel pending sub-agent jobs before waiting for the user." }

      return { answer: decoded.value.message, done: false, waitingForUser: true }
    }

    if (name === "yield_to_system_one") {
      const decoded = Schema.decodeUnknownOption(YieldArgs)(parsed)
      return hooks.handoff && Option.isSome(decoded) ? yield* hooks.handoff(decoded.value) : { output: "invalid arguments, or System One isn't available: run the check yourself" }
    }

    if (name === "kernel") return { output: yield* viaHook(name, KernelArgs, hooks.kernel, parsed) }

    // A note for the user now, as its own line wherever empty-vessel is shown; the run goes on.
    if (name === "tell_user") {
      const decoded = Schema.decodeUnknownOption(TellUserArgs)(parsed)
      if (Option.isNone(decoded)) return { output: "invalid arguments: provide a message for the user" }

      if (decoded.value.file !== undefined) {
        if ((hooks.depth ?? 0) !== 0) return { output: "File attachments are only available to the main agent." }

        if ((hooks.grants ?? ALL).files === "none") {
          return { output: "File attachments require file-read access." }
        }

        const delivery = yield* Delivery
        const sent = yield* Effect.suspend(() => delivery.sendFile(decoded.value.file!, decoded.value.message)).pipe(
          Effect.match({
            onFailure: (error) => ({ ok: false, output: `File delivery failed: ${deliveryError(error)}` }),
            onSuccess: () => ({ ok: true, output: "The user has the file and caption. Keep working." }),
          }),
        )
        if (sent.ok) state.told = state.now()
        return { output: sent.output }
      }

      yield* emit("note", hooks.depth ?? 0, decoded.value.message)
      state.told = state.now()
      return { output: "The user has it. Keep working." }
    }

    if (name === "more_output") {
      state.pruning = false
      yield* Effect.logDebug(`system one pruning undone ${JSON.stringify({ id: parsed?.id })}`)
      return { output: state.stash.get(String(parsed?.id)) ?? `no shortened output with id ${parsed?.id}` }
    }

    return undefined
  })

// After a command ran: show it, log it (evals read these lines), give it to the session (the full output), and if it's
// long, let System One hide what doesn't help the goal (the full text stays, for more_output). Returns what System Two
// gets back.
export const afterCommand = (name: string, parsed: unknown, output: string, hooks: Hooks, state: CallState) =>
  Effect.gen(function* () {
    if (name !== "tell_user") yield* emit("system-two", hooks.depth ?? 0, `  system two ran: ${shownAs(name, parsed)}`, bodyOf(name, parsed, output), cellSummary(name, parsed)) // a note has its own line
    yield* Effect.logDebug(`system two command ${JSON.stringify({ tool: name, args: parsed, output: output.slice(0, 8000) })}`)
    if (hooks.onCommand) yield* hooks.onCommand({ tool: name, args: parsed, output })

    if (!hooks.prune || !state.pruning || name !== "kernel" || output.length <= PRUNE_OVER) return output
    const shorter = yield* hooks.prune(shownAs(name, parsed), output)
    if (shorter.length >= output.length) return output
    const id = `out${state.stash.size + 1}`
    state.stash.set(id, output)
    return `${shorter}\n[System One shortened this output. If you need the hidden parts: more_output { id: "${id}" }]`
  })

// A run can't end with sub-agent jobs uncollected: they'd be lost (or cancelled) when it ends.
export const jobsReminder = (pending: ReadonlyArray<string>) =>
  `Before you finish: these sub-agent jobs haven't been collected:\n${pending.join("\n")}\nUse wait([...ids]) to collect their answers (wait again if they're still running), or cancel(id) for any you don't need. Then answer.`

// One tool call, start to finish, the same for every backend: shown as it starts, run, then shown, logged and recorded
// with its output (long output shortened by System One). A finishing check or waiting for the user ends the run: then
// the answer comes back instead of output. A run's calls share `state` (newCallState()).
export type CallResult = { readonly output: string } | Ended
export const callTool = (name: string, parsed: unknown, hooks: Hooks, state: CallState): Effect.Effect<CallResult> =>
  Effect.gen(function* () {
    yield* showActivity(name, parsed, hooks)
    const result = (yield* runTool(name, parsed, hooks, state)) ?? { output: `unknown tool: ${name}` }

    // A finishing check that passed only with a setup lesson in it (often how the lesson is found: npm test fails, then
    // the finishing check sets APP_MODE=test): the run doesn't end on it yet, so System Two can keep the lesson first.
    if ("answer" in result) {
      const lesson = result.done ? yield* lessonNote(name, parsed, "exit 0", hooks, state) : undefined
      if (!lesson) return result
      yield* Effect.logDebug(`system two notes ${JSON.stringify({ tool: name, notes: [lesson] })}`)
      return { output: `System One ran it: passed, and the task is done.\n\n${lesson} Then give your final answer (no more checks needed).` }
    }

    // After the result: what the user said meanwhile (first: it can change the plan), then the scope note and the
    // progress reminder.
    const output = yield* afterCommand(name, parsed, result.output, hooks, state)
    const said = hooks.inbox ? yield* hooks.inbox : []
    const scope = hooks.scope ? yield* hooks.scope() : undefined
    const lesson = yield* lessonNote(name, parsed, result.output, hooks, state)
    const notes = [fromUser(said), scope, lesson, progressReminder(hooks, state)].filter(Boolean)
    if (notes.length) yield* Effect.logDebug(`system two notes ${JSON.stringify({ tool: name, notes })}`)
    return { output: [output, ...notes].join("\n\n") }
  })

// Messages the user typed while System Two works, as System Two reads them.
export const fromUser = (messages: ReadonlyArray<string>) => messages.map((m) => `[The user, while you work: ${m}]`).join("\n")

// The user hasn't heard from System Two for progressEveryMs: the next tool result says so, and the clock restarts, so
// it says it again only after as long again.
// A setup lesson found the hard way (src/base/lessons.ts: a command failed, a later one worked with an env var or PATH
// added): suggest keeping it, once per lesson, unless memory already has it. Instructions alone didn't get these saved.
// The command is a cell's code or a check's command.
const lessonNote = (name: string, parsed: any, output: string, hooks: Hooks, state: CallState) =>
  Effect.gen(function* () {
    const command = String(name === "kernel" ? parsed?.code ?? "" : name === "yield_to_system_one" ? parsed?.command ?? "" : "")
    if (!command || !hooks.remembered) return undefined

    const added = lessonIn(state.failed, command, output).filter((v) => !state.lessons.has(v))
    if (exitOf(output) !== 0 || /System One judged this (a failure|broken)/.test(output)) state.failed.push(command)
    if (!added.length) return undefined

    for (const v of added) state.lessons.add(v)
    const known = yield* hooks.remembered()
    const fresh = added.filter((v) => !known.includes(v))
    if (!fresh.length) return undefined
    return `That looks like a setup lesson (a command failed, then this one passed with ${fresh.join(" ")}): keep it now with memory.add("project", "…"), one short line, so later sessions don't find it out again; skip it only if it was specific to this task.`
  })

const progressReminder = (hooks: Hooks, state: CallState) => {
  if (!hooks.progressEveryMs || state.now() - state.told < hooks.progressEveryMs) return undefined

  state.told = state.now()
  return `[It's been ${Math.round(hooks.progressEveryMs / 60_000)} minutes or more since the user heard from you: send a short progress note with tell_user (what's done, what's next, anything only they can do), then carry on.]`
}
