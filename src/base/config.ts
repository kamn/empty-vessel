import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { EMPTY_VESSEL_HOME, DEFAULT_HOME } from "./home"
import { described, section, setting } from "./setting"

// Unreadable file, broken JSON, or a value of the wrong shape all become this one typed error.
export class ConfigError extends Data.TaggedError("ConfigError")<{ message: string }> {}

// ~/.empty-vessel/config.json. Every setting says what it is (setting(), src/base/setting.ts) and is optional; a missing file
// means all defaults.
export const ConfigSchema = described({
  maxSteps: setting(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))), "System One's steps in one turn before it gives up", { default: 20 }), // later: unlimited, like Pi, once there's an abort key (see jev-plan.md)
  // Below OpenAI's 272k price jump; EMPTY_VESSEL_COMPACT_AT overrides it (for testing compaction on small sessions).
  compactAt: setting(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))), "Compact System Two's thread at the start of a turn once its last request was bigger than this many tokens", { default: 150_000 }),
  // Off by default: in real use echo once replaced a correct answer (it looked like a fine next step when "done" was borderline).
  testOptions: setting(Schema.Boolean, "Offer System One the early toy options (countdown, echo), for testing the loop and sub-agents", { default: false }),
  learnAfterTurn: setting(Schema.Boolean, "Learn after every turn (tool proposals, the notes and checks reviewer); off, empty-vessel refine does it when asked", { default: false }),
  ui: setting(Schema.Literals(["plain", "tui"]), "The interactive screen: plain lines, or tui (a live input box, the current step and a status line); -p and piped input are always plain", { default: "plain" }),
  theme: setting(Schema.Literals(["orange", "blue", "green", "teal"]), "Terminal colour palette (restart to apply)", { default: "teal" }),
  // This file is readable only by you; logins are kept in ~/.empty-vessel/auth.
  sources: setting(Schema.Record(Schema.String, described({
    url: setting(Schema.String, "A remote MCP server's address", { optional: true }),
    headers: setting(Schema.Record(Schema.String, Schema.String), "Headers sent to a remote server, such as an API key", { optional: true }),
    auth: setting(Schema.Literals(["oauth"]), "Log in to a remote server in your browser (empty-vessel login <name>)", { optional: true }),
    command: setting(Schema.String, "The command that starts a local MCP server", { optional: true }),
    args: setting(Schema.Array(Schema.String), "A local server's arguments", { optional: true }),
    env: setting(Schema.Record(Schema.String, Schema.String), "A local server's environment", { optional: true }),
  })), "Outside tools (MCP servers) that cells use by name, e.g. posthog.insights_query(…)", { default: {} }),
  // Adoption: all knobs, since the right values come from trial and error.
  adoption: section({
    // 2 for System One left the right one out most turns (adoption run 2); 5 is the next try.
    offerSystemOne: setting(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))), "Tools on trial offered to System One each turn", { default: 5 }),
    offerSystemTwo: setting(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))), "Tools on trial offered to System Two each turn", { default: 5 }),
    sampler: setting(Schema.Literals(["thompson", "uniform", "all"]), "How the offered tools are chosen: thompson offers those that help more, and untried ones, more often", { default: "thompson" }),
    reward: setting(Schema.Literals(["used", "ok", "verdict"]), "What counts as a tool helping: used, ok (used and gave an answer), or verdict (System Two said it helped)", { default: "ok" }),
    promoteTo: setting(Schema.Literals(["pool", "library"]), "Where promote puts a new tool: the pool, to prove itself, or straight into the library", { default: "pool" }),
    // Off by default (2026-09-30): in the learning benchmark it cost ~20–40% more for nothing kept that helped;
    // evals turn it on.
    askAtEndOfTurn: setting(Schema.Literals(["never", "whenSomethingToJudge", "whenSystemTwoRan", "always"]), "When to ask System Two after a turn whether the tools on trial helped and what could become a tool", { default: "never" }),
    maxProposals: setting(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))), "New tools of each kind System Two may propose per turn", { default: 1 }),
    graduateAfter: setting(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))), "Successes after which a tool on trial moves into the library", { default: 3 }),
    // 100, not 10 (user): a tool that isn't used often can still be worth keeping (a code-quality check that applies
    // once in fifty turns); how dropping should work is still to be rethought.
    dropAfter: setting(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))), "Offers after which a tool that rarely helps leaves the pool", { default: 100 }),
    dropBelowRate: setting(Schema.Number, "The success rate below which such a tool leaves the pool", { default: 0.2 }),
    proposals: setting(Schema.Literals(["eager", "conservative"]), "How readily System Two proposes tools: eager (whenever a general version could be used again) or conservative (only for work that will clearly come up again)", { default: "eager" }),
  }, "Adoption: candidate tools in each project's pool, offered each turn and kept or dropped by how they do"),
  maxDepth: setting(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))), "How deep sub-agents may go: 0 none, 1 children, 2 grandchildren", { default: 2 }),
  systemOne: section({
    use: setting(Schema.String, "The plugin that is System One (empty-vessel plugins list shows them; fake: fixed rules)", { default: "fake" }),
  }, "System One: the fast judgment model that decides every step"),
  // Each backend's own settings (its model…) are in plugins.<name>.config.
  systemTwo: section({
    use: setting(Schema.String, "The plugin that is System Two, or plugin:model for another of its models (claude:opus; empty-vessel plugins list shows them; fake: a stand-in reply)", { default: "fake" }),
    reasoning: setting(Schema.Literals(["low", "medium", "high", "xhigh", "max"]), "How hard System Two thinks before answering (Fill never reasons)", { default: "medium" }),
    // Claude: claude -p --max-turns, then one wrap-up with no tools. Later: unlimited, with an abort key.
    maxRounds: setting(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(1))), "Tool rounds in one System Two run; the last has no tools, so it must answer", { default: 30 }),
    // Results go to the model, not into cells (a search tool source would, later).
    webSearch: setting(Schema.Boolean, "Let System Two search the web with its backend's own search (Codex's web_search; Claude Code's WebSearch and WebFetch)", { default: true }),
    progressMinutes: setting(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))), "Minutes without a note to you (tell_user) before System Two is reminded to send one; 0: never reminded", { default: 5 }),
    scopeCheck: setting(Schema.Boolean, "Tell System Two to ask you first when its changes reach another part of the project (another package) than where it started", { default: true }),
    // src/system-two/style.ts: added to System Two's briefing each session.
    style: setting(Schema.Literals(["i-have-adhd", "none"]), "How System Two shapes what it writes to you: i-have-adhd (the i-have-adhd skill by Ayoub Ghriss, MIT: lead with the next action, numbered steps, no preamble), or none", { default: "i-have-adhd" }),
  }, "System Two: the model that thinks and writes code, whichever plugin it is"),
  channel: section({
    use: setting(Schema.String, "The conversation channel (terminal: built-in interactive routing)", { default: "terminal" }),
  }, "Where messages are received and replies are sent"),
  store: section({
    use: setting(Schema.String, "The plugin that keeps empty-vessel's files (disk: ~/.empty-vessel)", { default: "disk" }),
  }, "Where empty-vessel keeps what lasts between runs"),
  memory: section({
    use: setting(Schema.String, "The plugin that remembers (notes: one line per entry, kept in the store)", { default: "notes" }),
    // The notes plugin's size limits (src/base/memory.ts): a write that would go over fails until entries are merged.
    projectChars: setting(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))), "Characters this project's memory may hold (merge or remove entries to add more)", { default: 2200 }),
    agentChars: setting(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))), "Characters each agent's memory may hold (how it works with you, this machine)", { default: 2400 }),
  }, "What empty-vessel remembers across sessions"),
  // Capabilities: a cell can't import what isn't granted, the cells' services don't
  // provide it, System Two isn't told of it, and library tools that need it aren't offered. Without a sandbox, files
  // "read-only" with shell on isn't enforced (bash can write): a warning.
  kernel: section({
    tools: section({
      files: setting(Schema.Literals(["read-write", "read-only", "none"]), "Cells' access to the project's files (read, readText, write, edit), and Gather's", { default: "read-write" }),
      shell: setting(Schema.Boolean, "bash in cells, and System One's checks (a check is a command)", { default: true }),
      systemOne: setting(Schema.Boolean, "systemOne and judge in cells", { default: true }),
      agents: setting(Schema.Boolean, "Sub-agents from cells: spawn, wait, cancel, jobs", { default: true }),
      library: setting(Schema.Boolean, "The library in cells: promote, tools, handTools, and the learned tools", { default: true }),
      sources: setting(Schema.Boolean, "The tool sources (MCP servers) in cells", { default: true }),
    }, "The kernel's built-ins, each granted or not; default everything"),
  }, "The kernel: where cells run and the project is reached"),
  // `config` is checked by the plugin, not the core (src/plugins/<name>/config.ts says what it is).
  plugins: setting(Schema.Record(Schema.String, described({
    enabled: setting(Schema.Boolean, "Off: an outside plugin isn't loaded", { optional: true }),
    path: setting(Schema.String, "Where an outside plugin is (empty-vessel plugins add)", { optional: true }),
    from: setting(Schema.String, "Another copy of this plugin, under this section's name and with its config (\"openai\")", { optional: true }),
    config: setting(Schema.Unknown, "The plugin's own settings (empty-vessel doctor says what they are)", { optional: true }),
  })), "Each plugin's own section: its settings, and an outside plugin's path", { default: {} }),
})

// Settings that moved into a plugin's own section: still read from where they used to be (a value already in the
// plugin's section wins). [old section, old name, plugin, its name there]
const MOVED: ReadonlyArray<readonly [string, string, string, string]> = [
  ["systemOne", "apiKey", "jev", "apiKey"],
  ["systemTwo", "model", "codex", "model"],
  ["systemTwo", "fillModel", "codex", "fillModel"],
  ["systemTwo", "claudeModel", "claude", "model"],
  ["systemTwo", "claudeFillModel", "claude", "fillModel"],
]
export const movedIntoPlugins = (raw: Record<string, any>) => {
  for (const [section, old, plugin, key] of MOVED) {
    const value = raw[section]?.[old]
    if (value === undefined) continue

    const entry = raw.plugins?.[plugin] ?? {}
    raw.plugins = { ...raw.plugins, [plugin]: { ...entry, config: { [key]: value, ...entry.config } } }
    const { [old]: _, ...rest } = raw[section]
    raw[section] = rest
  }
  return raw
}

// The file as JSON, for the commands that edit it (sources, plugins): none or unreadable is {}. Written whole (a temp
// file renamed over it, so nothing reads half a file) and private: it can hold keys.
export const readConfigFile = (file: string): Record<string, any> => { try { return JSON.parse(readFileSync(file, "utf8")) } catch { return {} } }
export const writeConfigFile = (file: string, config: Record<string, unknown>) => {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
  chmodSync(file, 0o600)
}

// A separate EMPTY_VESSEL_HOME without its own config uses the usual one (so the Jev key isn't copied around).
export const CONFIG_FILE = existsSync(`${EMPTY_VESSEL_HOME}/config.json`) ? `${EMPTY_VESSEL_HOME}/config.json` : `${DEFAULT_HOME}/config.json`
const file = CONFIG_FILE

export class Config extends Context.Service<Config, typeof ConfigSchema.Type>()("empty-vessel/Config") {
  static readonly layer = Layer.effect(
    Config,
    Effect.gen(function* () {
      const raw = yield* Effect.try({
        try: () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}),
        catch: (e) => new ConfigError({ message: `${file}: ${e}` }),
      })
      // Parse only the two boolean spellings; other values fail schema validation.
      const learnAfterTurn = process.env.EMPTY_VESSEL_LEARN_AFTER_TURN

      if (learnAfterTurn !== undefined) {
        raw.learnAfterTurn = learnAfterTurn === "true" ? true : learnAfterTurn === "false" ? false : learnAfterTurn
      }

      if (process.env.EMPTY_VESSEL_COMPACT_AT) raw.compactAt = Number(process.env.EMPTY_VESSEL_COMPACT_AT)
      if (process.env.EMPTY_VESSEL_ADOPTION) raw.adoption = { ...raw.adoption, ...JSON.parse(process.env.EMPTY_VESSEL_ADOPTION) } // e.g. an eval's settings
      // adoption.offerJev was the name before System One's generic one: still read.
      if (raw.adoption?.offerJev !== undefined && raw.adoption.offerSystemOne === undefined) raw.adoption = { ...raw.adoption, offerSystemOne: raw.adoption.offerJev }
      if (process.env.EMPTY_VESSEL_CHANNEL) raw.channel = { ...raw.channel, use: process.env.EMPTY_VESSEL_CHANNEL }
      if (process.env.EMPTY_VESSEL_SYSTEM_TWO) raw.systemTwo = { ...raw.systemTwo, use: process.env.EMPTY_VESSEL_SYSTEM_TWO } // e.g. try claude for one run
      return yield* Schema.decodeUnknownEffect(ConfigSchema)(movedIntoPlugins(raw)).pipe(
        Effect.mapError((e) => new ConfigError({ message: `${file}: ${e.message}` })),
      )
    }),
  )
}
