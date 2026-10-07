import { agentsDir, applyAgent, ensureAgentsGuide, listAgents, loadAgent } from "./base/agents"
import { grantWarnings } from "./base/grants"
import { notGranted } from "./system-two/instructions"
import { readFileSync } from "node:fs"
import { Console, Effect, Redacted } from "effect"
import { Config, CONFIG_FILE } from "./base/config"
import { explain } from "./base/setting"
import { pluginSettings } from "./plugins/plugin"
import { allPlugins } from "./plugins/index"

// empty-vessel doctor: every plugin's settings checked against the config (and the environment), without starting a
// session, the outside ones (plugins.<name>.path) too, and whether those loaded. Secrets show as <redacted>. A plugin
// that isn't in use may be unset; one that is must be right.
const shown = (v: unknown) => (Redacted.isRedacted(v) ? "<redacted>" : String(v))

export const doctor = Effect.gen(function* () {
  const { systemOne, systemTwo, channel, plugins: sections } = yield* Config
  const inUse = new Set<string>([...([systemOne.use, systemTwo.use].map((use) => use.split(":")[0]!)), ...(channel.use === "terminal" ? [] : [channel.use])])
  yield* Console.log(`${CONFIG_FILE}\n  system one: ${systemOne.use} · system two: ${systemTwo.use} · channel: ${channel.use}\n`)
  const { plugins, outside } = yield* allPlugins

  let wrong = 0

  if (channel.use !== "terminal" && !plugins.some((p) => p.name === channel.use && p.provides.channel) && !outside.some((o) => o.name === channel.use && o.error)) {
    wrong++
    yield* Console.log(`  ✗ channel.use is "${channel.use}", but no plugin provides a channel by that name`)
  }

  for (const o of outside.filter((o) => o.error)) {
    if (inUse.has(o.name)) wrong++
    yield* Console.log(`  ${inUse.has(o.name) ? "✗" : "·"} ${o.name} (${sections[o.name]?.from ? "copy" : "outside"}, ${inUse.has(o.name) ? "in use" : "not in use"}): didn't load: ${o.error}`)
  }

  for (const { name, settings } of plugins.flatMap((p) => (p.settings ? [{ name: p.name, settings: p.settings }] : []))) {
    const used = inUse.has(name)
    const got = yield* Effect.result(pluginSettings(name, settings as never))
    const kind = sections[name]?.from ? `copy of ${sections[name]!.from}, ` : outside.some((o) => o.name === name) ? "outside, " : ""
    const tag = `${kind}${used ? "in use" : "not in use"}`

    if (got._tag === "Success") {
      const values = Object.entries(got.success as Record<string, unknown>).map(([k, v]) => `${k} ${shown(v)}`).join(" · ")
      yield* Console.log(`  ✓ ${name} (${tag}): ${values}`)
      continue
    }

    if (used) wrong++
    yield* Console.log(`  ${used ? "✗" : "·"} ${name} (${tag}): ${got.failure.message.replace(/\s*\n\s*/g, " ")}`) // a schema error spans lines
    // What each setting the error names is (its description, default, allowed values), so the fix is plain.
    const named = [...new Set([...got.failure.message.matchAll(/at \["(\w+)"\]/g)].map((m) => m[1]!))]
    for (const line of named.flatMap((key) => explain(settings.fields, key) ?? [])) yield* Console.log(`      ${line}`)
  }

  // What the plugins in use need on this machine (their setup checks: a CLI, a login…).
  for (const plugin of plugins.flatMap((p) => (p.setup && inUse.has(p.name) ? [p.setup] : []))) {
    for (const check of plugin.checks ?? []) {
      const good = yield* check.ok
      if (!good) wrong++
      yield* Console.log(good ? `  ✓ ${plugin.name}: ${check.what}` : `  ✗ ${plugin.name}: ${check.what}: ${check.fix}`)
    }
  }

  // What the kernel grants, if not everything; and the shell back door (src/base/grants.ts).
  const { kernel } = yield* Config
  const denied = notGranted(kernel.tools)
  if (denied.length) yield* Console.log(`\n  kernel: not granted: ${denied.join("; ")}`)
  for (const warning of grantWarnings(kernel.tools)) yield* Console.log(`  ${warning}`)

  // Settings in their old places are still read; setup writes them in today's shape.
  const raw = (() => { try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) } catch { return {} } })()
  const old = ["systemOne.apiKey", "systemTwo.model", "systemTwo.fillModel", "systemTwo.claudeModel", "systemTwo.claudeFillModel"]
    .filter((path) => { const [section, key] = path.split("."); return raw[section!]?.[key!] !== undefined })
  if (old.length) yield* Console.log(`\n  note: ${old.join(", ")} ${old.length === 1 ? "is" : "are"} in the old place (still read; empty-vessel setup rewrites the file in today's shape)`)

  if (wrong) yield* Console.log(`\n${wrong} plugin${wrong === 1 ? "" : "s"} in use ${wrong === 1 ? "has" : "have"} a problem.`)

  // Agents: each one loaded and applied over this config, as spawn would; the guide's place.
  ensureAgentsGuide()
  const config = yield* Config
  const agents = listAgents()
  yield* Console.log(`\nagents: ${agentsDir()} (how to make one: README.md there)${agents.length ? "" : "\n  none yet"}`)

  for (const { name } of agents) {
    const checked = yield* Effect.result(loadAgent(name).pipe(Effect.flatMap((agent) => applyAgent(config, agent).pipe(Effect.as(agent)))))
    yield* Console.log(checked._tag === "Success"
      ? `  ✓ ${name}${checked.success.description ? `: ${checked.success.description}` : ""}`
      : `  ✗ ${name}: ${checked.failure.message.replace(/\s*\n\s*/g, " ")}`)
  }
})
