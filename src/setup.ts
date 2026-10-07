import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Console, Effect } from "effect"
import { CONFIG_FILE, movedIntoPlugins } from "./base/config"
import { EMPTY_VESSEL_HOME } from "./base/home"
import type { PluginSetup } from "./base/plugin-setup"
import { copies, outsideIn, SETUPS } from "./plugins/index"

// Setup's own file: this home's config, never the fallback CONFIG_FILE can be (the default home's, when this home has
// none): setting up a fresh EMPTY_VESSEL_HOME must not read or rewrite the real one.
const SETUP_FILE = `${EMPTY_VESSEL_HOME}/config.json`

const KINDS = {
  channel: "Channel: where messages are received and replies are sent",
  systemOne: "System One: the fast judgment model that decides every step",
  systemTwo: "System Two: the model that thinks and writes code",
} as const

// How setup talks to you: a question and its answer (null: no answer), and a line out. Passed in, so a test can answer.
export type SetupIo = { readonly ask: (question: string) => string | null; readonly say: (line: string) => Effect.Effect<void> }

const has = (cmd: string) => Bun.which(cmd) !== null

// empty-vessel setup: check what empty-vessel needs, then go through every plugin (src/plugins/<name>/setup.ts): its checks, and
// what it asks for (a key is tried before it's saved); of each kind, the ones that are ready can be chosen. Writes
// the config (private: it can hold keys); settings already there are kept.
export const runSetup = (file: string, setups: ReadonlyArray<PluginSetup>, io: SetupIo) =>
  Effect.gen(function* () {
    yield* io.say("empty-vessel setup\n\nWhat empty-vessel needs:")
    for (const [good, what, fix] of [[true, `Bun ${Bun.version}`, ""], [has("git"), "git", "install git (empty-vessel finds a project's files with it)"], [has("bash"), "bash", "install bash (commands and checks run in it)"]] as const)
      yield* io.say(good ? `  ✓ ${what}` : `  ✗ ${what}: ${fix}`)

    // An older config comes out in today's shape (settings moved into their plugin's section).
    const current: Record<string, any> = movedIntoPlugins(existsSync(file) ? (() => { try { return JSON.parse(readFileSync(file, "utf8")) } catch { return {} } })() : {})
    const plugins: Record<string, any> = { ...current.plugins }
    const chosen: Record<string, string> = {}

    for (const kind of ["systemOne", "systemTwo", "channel"] as const) {
      // Channels are optional: Enter preserves an old setup, without asking for transport credentials.
      if (kind === "channel") {
        chosen.channel = current.channel?.use ?? "terminal"
        if (!setups.some((s) => s.kind === "channel")) continue
        const answer = (io.ask("\n  Configure a channel? (y/N; Enter keeps the current channel):") ?? "").trim()
        if (!/^y(es)?$/i.test(answer)) continue
      }

      yield* io.say(`\n${KINDS[kind]}`)
      const ready: Array<PluginSetup> = kind === "channel" ? [{ name: "terminal", kind: "channel", title: "Terminal (built in)" }] : []

      for (const plugin of setups.filter((s) => s.kind === kind)) {
        yield* io.say(`\n  ${plugin.title}${plugin.about ? ` · ${plugin.about}` : ""}`)
        let isReady = true

        for (const check of plugin.checks ?? []) {
          const good = yield* check.ok
          yield* io.say(good ? `    ✓ ${check.what}` : `    ✗ ${check.what}: ${check.fix}`)
          if (!good) isReady = false
        }

        // What it asks for, once its checks pass. Enter keeps what's there (or skips).
        for (const ask of isReady ? plugin.asks ?? [] : []) {
          const so = plugins[plugin.name]?.config ?? {}
          const had = so[ask.setting] !== undefined
          const choices = ask.choices ? yield* ask.choices(so) : []
          if (choices.length) yield* io.say(choices.map((c, i) => `      ${i + 1}. ${c}`).join("\n"))

          const answer = (io.ask(`    ${ask.prompt}${choices.length ? ", a number or a name" : ""} (Enter ${had ? "keeps the current one" : "to skip"}):`) ?? "").trim()
          const typed = choices[Number(answer) - 1] ?? answer
          if (!typed) { if (!had && !ask.optional) isReady = false; continue }
          if (choices.length && !choices.includes(typed)) { yield* io.say(`    ✗ ${typed} isn't one of them`); if (!had) isReady = false; continue }

          const works = ask.test ? yield* ask.test(typed, so) : true
          if (ask.test) yield* io.say(works ? `    ✓ it works` : `    ✗ ${ask.failed ?? "it didn't work"}`)
          if (!works) { if (!had) isReady = false; continue }
          plugins[plugin.name] = { ...plugins[plugin.name], config: { ...plugins[plugin.name]?.config, [ask.setting]: typed } }
        }

        if (isReady) ready.push(plugin)
      }

      chosen[kind] = pick(kind, ready, current[kind]?.use, setups, io)
      const plugin = ready.find((p) => p.name === chosen[kind])
      if (plugin?.defaults) plugins[plugin.name] = { ...plugins[plugin.name], config: { ...plugin.defaults, ...plugins[plugin.name]?.config } }
    }

    const systemOne = { ...current.systemOne, use: chosen.systemOne }
    const systemTwo = chosen.systemTwo === "fake" ? { ...current.systemTwo, use: "fake" } : { reasoning: "medium", ...current.systemTwo, use: chosen.systemTwo }
    const channel = current.channel || chosen.channel !== "terminal" ? { channel: { ...current.channel, use: chosen.channel } } : {}
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ ...current, systemOne, systemTwo, ...channel, ...(Object.keys(plugins).length ? { plugins } : {}) }, null, 2) + "\n")
    chmodSync(file, 0o600)

    yield* io.say(`\nWrote ${file} (only you can read it).`)
    for (const kind of ["systemOne", "systemTwo"] as const) {
      const title = setups.find((s) => s.name === chosen[kind])?.title
      yield* io.say(`  ${kind === "systemOne" ? "System One" : "System Two"}: ${title ?? `${chosen[kind]}${chosen[kind] === "fake" ? " (not real: make one of the above ready, then run setup again)" : ""}`}`)
    }
  })

// Of one kind: none ready keeps a choice setup doesn't manage (e.g. jev-mock), else the fake; one ready is it; several
// are asked about, Enter keeping the current one if it's among them.
const pick = (kind: PluginSetup["kind"], ready: ReadonlyArray<PluginSetup>, current: string | undefined, setups: ReadonlyArray<PluginSetup>, io: SetupIo) => {
  if (!ready.length) return current && current !== "fake" && !setups.some((s) => s.name === current) ? current : "fake"
  if (ready.length === 1) return ready[0]!.name

  const fallback = ready.some((p) => p.name === current) ? current! : ready[0]!.name
  const list = ready.map((p, i) => `    ${i + 1}. ${p.name}: ${p.title}${p.name === fallback ? " (Enter)" : ""}`).join("\n")
  const answer = (io.ask(`\n  ${kind === "channel" ? "Channel" : kind === "systemOne" ? "System One" : "System Two"}: which one?\n${list}\n  Number:`) ?? "").trim()
  const index = Number(answer) - 1
  return ready[index]?.name ?? ready.find((p) => p.name === answer)?.name ?? fallback
}

// Every plugin's setup: the bundled ones, their copies (plugins.<name>.from), and the outside ones this config names
// (plugins.<name>.path; empty-vessel plugins add) that load; one that doesn't is said, not offered.
const io: SetupIo = { ask: (question) => prompt(question), say: (line) => Console.log(line) }
export const setup = Effect.gen(function* () {
  const sections = movedIntoPlugins(existsSync(SETUP_FILE) ? (() => { try { return JSON.parse(readFileSync(SETUP_FILE, "utf8")) } catch { return {} } })() : {}).plugins ?? {}
  const outside = yield* outsideIn(sections)
  for (const o of outside) if ("error" in o) yield* io.say(`(the outside plugin ${o.name} didn't load: ${o.error})`)

  const theirs = [...outside, ...copies(sections)].flatMap((o) => ("plugin" in o && o.plugin?.setup ? [o.plugin.setup] : []))
  yield* runSetup(SETUP_FILE, [...SETUPS, ...theirs], io)
})

// At start-up: say plainly if a system is fake (or a mock), what that means, and what to run.
// Warnings for a setup that isn't real yet, as lines (the start of a session shows them, in the TUI or printed).
export const fakeWarnings = (systemOne: string, systemTwo: string): ReadonlyArray<string> => {
  if (!existsSync(CONFIG_FILE)) return ["⚠ empty-vessel isn't set up yet: both systems are fakes. Run `empty-vessel setup`."]
  const notReal = (use: string) => use === "fake" || use.endsWith("-mock")
  return [
    ...(notReal(systemOne) ? [`⚠ System One is ${systemOne}: steps aren't really judged. Run \`empty-vessel setup\`.`] : []),
    ...(notReal(systemTwo) ? [`⚠ System Two is ${systemTwo}: nothing really gets done. Run \`empty-vessel setup\`.`] : []),
  ]
}
