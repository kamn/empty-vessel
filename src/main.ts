#!/usr/bin/env bun
import { grantWarnings } from "./base/grants"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Exit, Fiber, LogLevel, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { TerminalAskUser } from "./ui/ask"
import { Background } from "./base/background"
import { allPlugins, ChannelFromConfig, describeSystemTwo, PLUGINS, StoreAndMemoryFromConfig, SystemOneFromConfig } from "./plugins"
import { channelRoot } from "./channel-root"
import { PluginError } from "./plugins/plugin"
import { addPlugin, kindsOf, removePlugin } from "./plugins/outside"
import { Config } from "./base/config"
import { loadContextFiles } from "./base/context"
import { logo } from "./ui/logo"
import { firstLoad, playOnboarding } from "./ui/onboarding/player"
import { memoryCommand, recentNotes } from "./learning/notes"
import { latestSession, makeSession, openSession, SESSIONS, type SessionHandle } from "./base/session"
import { cellsBeforeRules, loadConversation, useSystemTwo } from "./loop/resume"
import { doctor } from "./doctor"
import { fakeWarnings, setup } from "./setup"
import { tui } from "./tui"
import { releaseAgent, reportState } from "./integrations/herdr"
import { agentCommand, answer, farewell, firstAgent, modelCommand, resumeAgent, stopped as noteStopped, usageLine, userCommand } from "./answer"
import { SystemTwoLayers } from "./loop/systems"
import { ensureAgentsGuide } from "./base/agents"
import type { SystemOne } from "./system-one/systemone"
import { addSource, closeSources, describeSources, entryFor, loginTo, makeSources, removeSource, useSources } from "./loop/sources"
import { type Conversation, newConversation } from "./loop/turnkit"
import { refineCommand } from "./loop/refine"
import { skillCommand } from "./loop/skill-commands"
import { Usage } from "./base/usage"
import { EMPTY_VESSEL_HOME } from "./base/home"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

// How many times empty-vessel has started (kept in ~/.empty-vessel/starts), so the logo's colours rotate: one palette per start.
const nextStart = () => {
  const file = `${EMPTY_VESSEL_HOME}/starts`
  const n = Number(existsSync(file) ? readFileSync(file, "utf8") : 0) || 0
  try { mkdirSync(EMPTY_VESSEL_HOME, { recursive: true }); writeFileSync(file, String(n + 1)) } catch {} // a missed count only repeats a colour
  return n
}

// The walkthrough of empty-vessel's two ideas: on the first load in a empty-vessel home, before setup,
// and on demand (empty-vessel onboarding). A marker in the home says it was shown; either way it can lead into setup.
const ONBOARDED = `${EMPTY_VESSEL_HOME}/onboarded`
const onboarding = Effect.gen(function* () {
  const choice = yield* playOnboarding()
  try { mkdirSync(EMPTY_VESSEL_HOME, { recursive: true }); writeFileSync(ONBOARDED, new Date().toISOString()) } catch {} // at worst, it shows again

  if (choice === "later") return yield* Console.log("When you're ready: empty-vessel setup. To see the walkthrough again: empty-vessel onboarding.")
  yield* setup
  yield* Console.log("\nThen run empty-vessel to start.")
})
const showOnboarding = (prompt: Option.Option<string>) =>
  firstLoad({ interactive: process.stdin.isTTY === true && process.stdout.isTTY === true, prompt: Option.isSome(prompt), configured: existsSync(`${EMPTY_VESSEL_HOME}/config.json`), shown: existsSync(ONBOARDED) })

// Read one line from the terminal. null means Ctrl+D (end of input).
const readLine = Effect.sync(() => prompt(">"))

// One message end to end: the reply, then time and tokens for this turn and the session so far (before the next prompt).
const answerAndShow = (session: SessionHandle, input: string, conversation: Conversation) =>
  Effect.gen(function* () {
    const { reply, usage, remembered } = yield* answer(session, input, conversation)
    yield* Console.log(reply)
    for (const line of [...remembered, ...usage]) yield* Console.log(line)
    return reply
  })

// Interactive: Ctrl+C stops the current turn, not empty-vessel. The turn runs on its own fiber and the key interrupts it
// (a running bash command is killed with it). The thread is tidied and told what happened; the prompt comes back.
const answerOrStop = (session: SessionHandle, input: string, conversation: Conversation) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(answerAndShow(session, input, conversation))
    let stopped = false
    const stop = () => { stopped = true; Effect.runFork(Fiber.interrupt(fiber)) }

    // During the turn, Ctrl+C is ours: runMain's own handler (which stops all of empty-vessel) is set aside, then put back.
    const theirs = process.listeners("SIGINT") as Array<() => void>
    process.removeAllListeners("SIGINT")
    process.once("SIGINT", stop)
    const exit = yield* Fiber.await(fiber).pipe(Effect.ensuring(Effect.sync(() => {
      process.removeListener("SIGINT", stop)
      for (const listener of theirs) process.on("SIGINT", listener)
    })))

    if (Exit.isSuccess(exit)) return exit.value
    if (!stopped) return yield* Effect.failCause(exit.cause)

    yield* Console.log("(stopped)")
    return yield* noteStopped(session, input, conversation)
  })

// The root agent: same turn, but input comes from the terminal (or --prompt) and the reply goes to the screen.
// `resume`: a session (its Store key) to continue (from --continue or --resume), or none for a new session.
const root = (prompt: Option.Option<string>, resume: string | undefined) => Effect.gen(function* () {
  // The tool sources (outside tools), made once and shared by every kernel; local servers stop when empty-vessel does.
  useSources(makeSources((yield* Config).sources))

  // One-shot prompts remain terminal output; interactive channels share the agent.
  if (Option.isNone(prompt) && (yield* Config).channel.use !== "terminal") {
    return yield* channelRoot(resume).pipe(
      Effect.provide(ChannelFromConfig),
      Effect.mapError((error) => new PluginError({ what: "channel", message: error.message })),
    )
  }

  // The logo, interactive only (keeps -p output clean): shown in the TUI as it takes over the screen, else printed now.
  // With the TUI, the start of a session (the logo, the session, the systems) is shown in it, under the logo, as it
  // takes over the screen; otherwise it's printed as it comes.
  const withTui = Option.isNone(prompt) && (yield* Config).ui === "tui" && process.stdin.isTTY === true
  const intro: Array<string> = []
  const say = (line: string) => (withTui ? Effect.sync(() => { intro.push(line) }) : Console.log(line))
  const banner = Option.isNone(prompt) ? logo(nextStart(), process.stdout.isTTY === true && !process.env.NO_COLOR, (yield* Config).theme) : undefined
  if (banner) yield* say(banner)

  const session = resume ? yield* openSession(resume) : yield* makeSession(SESSIONS)
  const conversation = resume ? loadConversation(session.dir) : newConversation() // this session's memory, for System Two and for System One
  const last = conversation.history.at(-1)
  yield* say(resume
    ? `session ${session.id} (resumed: ${conversation.history.length} earlier messages${last ? `; last: "${last.user.slice(0, 60)}"` : ""})`
    : `session ${session.id}`)
  yield* reportState("idle", ["--agent-session-id", session.id])

  const older = resume ? cellsBeforeRules(session.dir) : 0
  if (older) yield* say(`note: ${older} kernel cell${older === 1 ? "" : "s"} in this session came before the kernel's rules; new cells can't import their definitions (redefine what's needed)`)

  // This startup listing is diagnostic only; System Two loads its own context.
  const debug = yield* LogLevel.isEnabled("Debug")

  if (debug) {
    const contextFiles = yield* loadContextFiles(process.cwd())
    const paths = contextFiles.map((f) => f.path).join(", ") || "(none)"

    yield* say(`context: ${paths}`)

    // Startup diagnostics only; the agent still loads earlier-session context independently.
    const notes = yield* recentNotes(process.cwd())

    if (notes.length) {
      yield* say(`notes from earlier sessions:${notes.map((n) => `\n  ${n.kind}: ${n.text}`).join("")}`)
    }
  }

  const { systemOne, systemTwo, maxSteps, maxDepth, ui, kernel } = yield* Config
  const two = yield* describeSystemTwo
  yield* say(`system one: ${systemOne.use} · system two: ${two.long} · max ${maxSteps} steps, depth ${maxDepth}`)
  for (const warning of [...fakeWarnings(systemOne.use, systemTwo.use), ...grantWarnings(kernel.tools)]) yield* say(warning)
  ensureAgentsGuide() // ~/.empty-vessel/agents/README.md: how to make an agent, when it's missing

  // The services each turn and command runs with: an agent (or /model) replaces System Two's among them.
  let services = yield* Effect.context<Effect.Services<ReturnType<typeof answerOrStop | typeof userCommand | typeof refineCommand>> | Config | SystemOne>()
  const resumed = yield* resumeAgent(session, conversation, services) // a resumed session goes on as its agent
  services = resumed.services
  if (resumed.line) yield* say(resumed.line)

  // Resumed with another System Two than last time (the agent's, if it goes on as one): it takes over from the
  // kernel's record.
  const use = resumed.use ?? systemTwo.use
  const from = yield* useSystemTwo(session, conversation, use)
  if (from) yield* say(`system two: ${from} → ${use}: the new one takes over from the kernel's record and the last exchanges`)

  // Before a conversation's first message, System One picks its agent.
  const pick = (input: string) =>
    Effect.gen(function* () {
      const picked = yield* firstAgent(session, conversation, input, services)
      services = picked.services
      if (picked.line) yield* say(picked.line)
    })

  // Both CLI paths activate skills on the host and keep the typed command in history.
  const runInput = (input: string) => Effect.gen(function* () {
    const skill = yield* skillCommand(session, conversation, input)
    if (skill?.kind === "reply") return yield* Console.log(skill.reply)
    const turnInput = skill?.kind === "activation" ? skill.content : input
    yield* pick(turnInput)
    const reply = yield* answerOrStop(session, turnInput, conversation).pipe(Effect.provideContext(services))
    conversation.history.push({ user: input, answer: reply })
  }).pipe(Effect.ensuring(Effect.sync(() => { conversation.explicitSkill = false })))

  const background = yield* Background
  if (Option.isSome(prompt)) {
    yield* runInput(prompt.value) // one message, then exit (Ctrl+C stops it cleanly first)
    yield* background.drain // … once the background work (the reviewer, adoption) is done

    // What that background work spent: it runs after the turn's line was printed, so it would be counted nowhere.
    const { turn: after } = yield* (yield* Usage).take
    if (after.systemOne.input + after.systemTwo.input) yield* say(usageLine("learning", after))
    return
  }

  // The TUI, if the config asks for it (and there's a terminal to draw on).
  // Leaving: how to resume, and what this run spent (then the background work finishes).
  const bye = Effect.gen(function* () {
    for (const line of yield* farewell(session)) yield* Console.log(line)
    return yield* background.drain
  })

  if (withTui) {
    yield* tui(session, conversation, `system one: ${systemOne.use} · system two: ${two.short} · session ${session.id.slice(-8)}`, intro.join("\n")).pipe(Effect.provideContext(services))
    return yield* bye
  }

  while (true) {
    const line = yield* readLine
    if (line === null) yield* Console.log("") // Ctrl+D: no newline was typed after the prompt
    if (line === null || line === "/exit") return yield* bye
    // !command / !!command: a shell command you run (its output handed to empty-vessel, or with !! only shown to you).
    const shell = line.match(/^(!!?)\s*(.*\S)/)
    if (shell) { yield* Console.log(yield* userCommand(session, conversation, shell[2]!, shell[1] === "!").pipe(Effect.provideContext(services))); continue }
    // /refine ([--yes], log, undo <id>): look back over this project's sessions, when asked (src/loop/refine.ts); /flag <note>: mark this moment for it.
    if (/^\/refine(?=\s|$)/.test(line)) { yield* Console.log(yield* refineCommand(line.slice("/refine".length)).pipe(Effect.provideContext(services))); continue }
    // /memory (remove <scope> <n>, edit [scope]): what empty-vessel remembers (src/learning/notes.ts).
    if (/^\/memory(?=\s|$)/.test(line)) { yield* Console.log(yield* memoryCommand(line.slice("/memory".length)).pipe(Effect.provideContext(services))); continue }
    const flag = line.match(/^\/flag(?=\s|$)\s*(.*)$/)
    if (flag) { yield* session.record("flag", flag[1]!.trim(), { running: false, activity: "" }).pipe(Effect.ignore); yield* Console.log("flagged"); continue }

    // /model [name]: which System Two, or another for the rest of the session.
    const model = line.match(/^\/model(?=\s|$)\s*(\S*)/)
    if (model) {
      const switched = yield* modelCommand(session, conversation, model[1]!, services)
      services = switched.services
      yield* Console.log(switched.reply)
      continue
    }

    // /agent [name]: which agent this conversation works as; before the first message, pick one yourself.
    const named = line.match(/^\/agent(?=\s|$)\s*(\S*)/)
    if (named) {
      const chose = yield* agentCommand(session, conversation, named[1]!, services)
      services = chose.services
      yield* Console.log(chose.reply)
      continue
    }

    yield* runInput(line)
  }
})

// The systems and services a turn needs, connected from the config (for the main command and refine).
const withSystems = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
  Effect.provide([SystemOneFromConfig, SystemTwoLayers, Background.layer, TerminalAskUser, Usage.layer, StoreAndMemoryFromConfig]),
  Effect.provide(Config.layer), // outside the others: SystemOneFromConfig and SystemTwoLayers need Config too
)

// Command line: no arguments = interactive. --help and --version come free from Effect's CLI.
// New flags go in the object below.
const emptyVessel = Command.make(
  "empty-vessel",
  {
    prompt: Flag.String("prompt").pipe(
      Flag.withAlias("p"),
      Flag.withDescription("Run one turn with this input, print the reply, and exit"),
      Flag.optional,
    ),
    continue: Flag.Boolean("continue").pipe(Flag.withAlias("c"), Flag.withDefault(false), Flag.withDescription("Continue the newest session started in this folder")),
    resume: Flag.String("resume").pipe(Flag.withDescription("Continue this session (its id)"), Flag.optional),
  },
  // The systems are connected here, inside the main command, so `empty-vessel setup` (and --help) work even when the
  // config is missing, a key is wrong or the Codex login expired: those are exactly what setup fixes.
  // The first load shows the walkthrough instead (before the systems connect: there may be no keys yet).
  ({ prompt, continue: latest, resume }) => showOnboarding(prompt) ? onboarding : Effect.gen(function* () {
      const dir = Option.isSome(resume) ? `${SESSIONS}/${resume.value}` : latest ? yield* latestSession(process.cwd()) : undefined
      if (latest && !dir) yield* Console.log("no earlier session in this folder: starting a new one")
      return yield* root(prompt, dir).pipe(
        Effect.ensuring(Effect.sync(closeSources)),
        Effect.ensuring(releaseAgent), // hand the pane back to Herdr on exit, including Ctrl+C
      )
    }).pipe(withSystems),
).pipe(
  Command.withDescription("A System One-first coding agent harness"),
  Command.withSubcommands([
    Command.make("setup", {}, () => setup).pipe(Command.withDescription("Check what empty-vessel needs, add your Jev key, and write ~/.empty-vessel/config.json")),
    Command.make("doctor", {}, () => doctor.pipe(Effect.provide(Config.layer), Effect.catch((e) => Console.error(`doctor: ${e.message}`)))).pipe(Command.withDescription("Check every plugin's settings (secrets shown as <redacted>), without starting a session")),
    Command.make("refine", { yes: Flag.Boolean("yes").pipe(Flag.withDefault(false), Flag.withDescription("Keep every proposed note and tool without asking")), args: Argument.String("what").pipe(Argument.withDescription("nothing (refine now), log, or undo <id>"), Argument.variadic()) }, ({ args, yes }) =>
      Effect.gen(function* () {
        useSources(makeSources((yield* Config).sources))
        yield* Console.log(yield* refineCommand([yes ? "--yes" : "", ...args].join(" ").trim()))
      }).pipe(Effect.ensuring(Effect.sync(closeSources)), withSystems),
    ).pipe(Command.withDescription("Look back over this project's sessions since the last refine: your /flags, what to fix in empty-vessel, and proposed notes and tools (kept only with your OK, or --yes); log lists past refines, undo <id> takes an edit back")),
    Command.make("memory", { args: Argument.String("what").pipe(Argument.withDescription("nothing (list), remove <scope> <n>, or edit [scope]"), Argument.variadic()) }, ({ args }) =>
      memoryCommand(args.join(" "), true).pipe(Effect.flatMap((text) => Console.log(text)), Effect.provide(StoreAndMemoryFromConfig), Effect.provide(Config.layer)),
    ).pipe(Command.withDescription("What empty-vessel remembers (this agent, this project): each entry numbered, how full each scope is; remove <scope> <n> forgets one, edit opens the file")),
    Command.make("onboarding", {}, () => onboarding).pipe(Command.withDescription("Show the walkthrough of empty-vessel's two ideas again (it leads into setup)")),
    Command.make("login", { source: Argument.String("source").pipe(Argument.withDescription("A remote tool source in the config's sources, with \"auth\": \"oauth\"")) }, ({ source }) =>
      Effect.gen(function* () {
        const said = yield* loginTo(source, (yield* Config).sources)
        yield* Console.log(said)
      }).pipe(Effect.catch((e) => Console.error(`login: ${e instanceof Error ? e.message : String(e)}`)), Effect.provide(Config.layer)),
    ).pipe(Command.withDescription("Log in to a remote tool source (OAuth in your browser); the login is kept in ~/.empty-vessel/auth")),
    // Tool sources from the command line, like `claude mcp add`: no need to edit config.json by hand.
    Command.make("plugins").pipe(
      Command.withDescription("Plugins from outside empty-vessel's repo (a folder whose default export is a plugin): add, list, remove"),
      Command.withSubcommands([
        Command.make("add", { path: Argument.String("path").pipe(Argument.withDescription("The plugin's folder (its package.json main, else index.ts) or file")) }, ({ path }) =>
          addPlugin(`${EMPTY_VESSEL_HOME}/config.json`, path, PLUGINS.map((p) => p.name)).pipe(
            Effect.flatMap((p) => Console.log(`Added ${p.name} (${kindsOf(p)}, for core ${p.core}). Choose it with empty-vessel setup, or in config.json (e.g. "${Object.keys(p.provides)[0]}": { "use": "${p.name}" }).`)),
            Effect.catch((e) => Console.error(`plugins add: ${e}`)))),
        Command.make("list", {}, () =>
          Effect.gen(function* () {
            const { plugins, outside } = yield* allPlugins
            const { plugins: sections } = yield* Config
            for (const p of plugins) {
              const from = sections[p.name]?.from ? `copy of ${sections[p.name]!.from}` : outside.some((o) => o.name === p.name) ? `${sections[p.name]?.path} (core ${p.core})` : "bundled"
              yield* Console.log(`${p.name.padEnd(10)} ${kindsOf(p).padEnd(22)} ${from}`)
            }
            for (const o of outside.filter((o) => o.error)) yield* Console.log(`${o.name.padEnd(10)} ${"didn't load".padEnd(22)} ${o.error}`)
          }).pipe(Effect.provide(Config.layer), Effect.catch((e) => Console.error(`plugins list: ${e.message}`)))),
        Command.make("remove", { name: Argument.String("name") }, ({ name }) => {
          const using = removePlugin(`${EMPTY_VESSEL_HOME}/config.json`, name)
          return Console.log(!using ? `No outside plugin named ${name}.` : `Removed ${name} (its settings stay).${using.length ? ` ${using.join(" and ")} still use${using.length === 1 ? "s" : ""} it: choose another (empty-vessel setup).` : ""}`)
        }),
      ]),
    ),
    Command.make("sources").pipe(
      Command.withDescription("Outside tools (MCP servers) that cells use like built-ins: add, list, remove"),
      Command.withSubcommands([
        Command.make("add", {
          name: Argument.String("name").pipe(Argument.withDescription("What cells import it as, e.g. posthog")),
          target: Argument.String("target").pipe(Argument.withDescription("A server URL (remote), or a command to start (local, in quotes)")),
          oauth: Flag.Boolean("oauth").pipe(Flag.withDefault(false), Flag.withDescription("Log in with OAuth in your browser (asked for right after adding)")),
          header: Flag.KeyValuePair("header").pipe(Flag.withDescription("A header to send, e.g. --header authorization=\"Bearer …\" (repeat for more)"), Flag.optional),
        }, ({ name, target, oauth, header }) =>
          Effect.gen(function* () {
            const entry = entryFor(target, { oauth, ...(Option.isSome(header) ? { headers: header.value } : {}) })
            yield* Effect.try(() => addSource(`${EMPTY_VESSEL_HOME}/config.json`, name, entry))
            yield* Console.log(`Added ${name}. Cells can use its tools as ${name}.<tool>(…).`)
            // The entry just added, not the config: that was read when the command started, before this add.
            if (oauth) yield* Console.log(yield* loginTo(name, { [name]: entry }))
          }).pipe(Effect.catch((e) => Console.error(`sources add: ${e instanceof Error ? e.message : String(e)}`)))),
        Command.make("list", {}, () =>
          Effect.gen(function* () {
            const lines = describeSources((yield* Config).sources)
            yield* Console.log(lines.length ? lines.join("\n") : "No tool sources yet: empty-vessel sources add <name> <url or command>")
          }).pipe(Effect.provide(Config.layer))),
        Command.make("remove", { name: Argument.String("name") }, ({ name }) =>
          Console.log(removeSource(`${EMPTY_VESSEL_HOME}/config.json`, name) ? `Removed ${name} (and its login).` : `No source named ${name}.`)),
      ]),
    ),
  ]),
)

emptyVessel.pipe(
  Command.run({ version: "0.0.1" }),
  Effect.catchTag("SessionError", (e) => Console.error(`session error: ${e.cause}`)),
  Effect.catchTag("ConfigError", (e) => Console.error(`config error: ${e.message}`)),
  Effect.catchTag("PluginError", (e) => Console.error(`${e.what}: ${e.message}`)),
  Effect.catchTag("ContextError", (e) => Console.error(`can't read ${e.path}: ${e.cause}`)),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
)
