import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { Effect } from "effect"
import { readConfigFile, writeConfigFile } from "../base/config"
import { undescribed } from "../base/setting"
import { CORE_VERSION } from "../base/version"
import type { Plugin } from "./plugin"

// Plugins from outside empty-vessel's repo: config.json's plugins.<name>.path, a folder (its
// package.json's main, else index.ts) or a file whose default export is a Plugin named <name>. Loaded once per process,
// all at once.
// ponytail: from a checkout of empty-vessel only; the compiled executable can't import an outside plugin's TypeScript yet.

const EMPTY_VESSEL = resolve(import.meta.dir, "../..") // the package whose exports are the core ("empty-vessel")

// A plugin's imports of "empty-vessel" and "effect" must be empty-vessel's own copies: one Effect, so a service it provides is the
// one the core asks for (two copies make two different SystemTwo tags). Linked into its node_modules; a link left
// pointing elsewhere (another checkout) is pointed here. A copy of its own (installed, not a link), or one a dependency
// brought along (node_modules/<dep>/node_modules/effect), is never deleted: the plugin is refused, saying what to do.
// Returns why not, or undefined.
const CORE_PACKAGES = [["empty-vessel", EMPTY_VESSEL], ["effect", join(EMPTY_VESSEL, "node_modules/effect")]] as const
const linkCore = (folder: string) => {
  const modules = join(folder, "node_modules")
  mkdirSync(modules, { recursive: true })

  for (const [name, target] of CORE_PACKAGES) {
    const link = join(modules, name)
    const stat = (() => { try { return lstatSync(link) } catch { return undefined } })()
    if (stat && !stat.isSymbolicLink()) return `it has its own copy of ${name} (node_modules/${name}): list ${name} as a peerDependency, remove that folder, and empty-vessel links its own`
    if (stat && realpathOr(link) === realpathSync(target)) continue
    if (stat) unlinkSync(link) // a link, pointing elsewhere: only the link goes
    symlinkSync(target, link)
  }

  const nested = nestedCopies(modules)
  return nested.length ? `its dependencies bring their own copy of Effect (${nested.join(", ")}): make effect a peerDependency of theirs, or a version they accept empty-vessel's (${version(CORE_PACKAGES[1][1])}), and reinstall` : undefined
}
const realpathOr = (path: string) => { try { return realpathSync(path) } catch { return undefined } }
const version = (dir: string) => { try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version } catch { return "?" } }

// Copies of effect a dependency installed under itself: node_modules/<dep>/node_modules/effect, scoped deps too.
const nestedCopies = (modules: string) =>
  readdirSync(modules).flatMap((dep) => (dep.startsWith("@") ? readdirSync(join(modules, dep)).map((d) => `${dep}/${d}`) : [dep]))
    .filter((dep) => !CORE_PACKAGES.some(([name]) => name === dep) && existsSync(join(modules, dep, "node_modules/effect/package.json")))
    .map((dep) => `node_modules/${dep}/node_modules/effect ${version(join(modules, dep, "node_modules/effect"))}`)

// Which cores a plugin works with, as a semver range: one version ("0.0.8"), a range (">=0.0.5 <=0.0.9"), or several
// ("0.0.5 || 0.0.7"). While the core is 0.0.x every change may break a plugin, so a plugin lists what it was tried on.
export const fitsCore = (wanted: string, core = CORE_VERSION) => Bun.semver.satisfies(core, wanted)

// A plugin at `path`: imported, then checked (a Plugin, written for this core).
const loadAt = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      const full = resolve(path.replace(/^~(?=\/)/, process.env.HOME ?? "~"))
      const folder = statSync(full).isDirectory() ? full : dirname(full)
      const refused = linkCore(folder)
      if (refused) throw new Error(refused)
      const main = statSync(full).isDirectory() ? (await Bun.file(join(full, "package.json")).json().catch(() => ({}))).main ?? "index.ts" : undefined
      return (await import(main ? join(full, main) : full)).default as Plugin | undefined
    },
    catch: (e) => `can't load it from ${path}: ${e instanceof Error ? e.message : e}`,
  }).pipe(Effect.flatMap((p) =>
    !p || typeof p !== "object" || !p.provides || !p.name ? Effect.fail(`${path} has no default export that is a plugin`)
    : Object.entries(p.provides).some(([kind, provider]) =>
      !["systemOne", "systemTwo", "store", "memory", "channel", "actionGuard"].includes(kind) || !Effect.isEffect(provider))
      ? Effect.fail(`${p.name} has an unknown plugin kind or a provider that is not an Effect`)
    : !p.core ? Effect.fail(`${p.name} doesn't say which cores it works with (core: "${CORE_VERSION}", or a range)`)
    : !fitsCore(p.core) ? Effect.fail(`${p.name} works with core ${p.core}; this is ${CORE_VERSION}`)
    // Every setting says what it is (the types require it; a JavaScript plugin skips the types, so it's checked here).
    : p.settings && undescribed(p.settings.fields).length ? Effect.fail(`${p.name}'s settings don't say what they are: ${undescribed(p.settings.fields).join(", ")} (make each with setting(schema, description) from "empty-vessel")`)
    : Effect.succeed(p)))

// The one the config names `name`: it has to be that plugin.
const loadOne = (name: string, path: string) =>
  loadAt(path).pipe(Effect.flatMap((p) => (p.name === name ? Effect.succeed(p) : Effect.fail(`${path} is the plugin "${p.name}", not "${name}"`))))

// What a plugin provides, in words: "system two", "store".
export const kindsOf = (p: Plugin) => Object.keys(p.provides).map((k) => k.replace(/([A-Z])/g, " $1").toLowerCase()).join(", ")

// empty-vessel plugins add <path>: load it (so a plugin that wouldn't load isn't added), then record its path in this home's
// config under its own name, beside any settings it already has there.
export const addPlugin = (file: string, path: string, bundled: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const plugin = yield* loadAt(path)
    if (bundled.includes(plugin.name)) return yield* Effect.fail(`${plugin.name} is a bundled plugin's name: rename the outside one`)

    const config = readConfigFile(file)
    const entry = { ...config.plugins?.[plugin.name], path: resolve(path.replace(/^~(?=\/)/, process.env.HOME ?? "~")) }
    writeConfigFile(file, { ...config, plugins: { ...config.plugins, [plugin.name]: entry } })
    return plugin
  })

// empty-vessel plugins remove <name>: forget its path (its settings stay, for adding it back); what still uses it, to warn.
export const removePlugin = (file: string, name: string) => {
  const config = readConfigFile(file)
  const { path, enabled: _, ...rest } = config.plugins?.[name] ?? {}
  if (!path) return undefined

  const plugins = { ...config.plugins }
  if (Object.keys(rest).length) plugins[name] = rest
  else delete plugins[name]
  writeConfigFile(file, { ...config, plugins })
  return [
    ...["systemOne", "systemTwo", "store", "memory", "channel"].filter((kind) => config[kind]?.use?.split(":")[0] === name),
    ...(Array.isArray(config.actionGuard?.use) && config.actionGuard.use.includes(name) ? ["actionGuard"] : []),
  ]
}

// Every plugin with a path in the config (and not `enabled: false`), except one reusing a bundled plugin's name: the ones
// that loaded, and why each other didn't.
export const loadOutside = (sections: Readonly<Record<string, { readonly path?: string; readonly enabled?: boolean }>>, bundled: ReadonlyArray<string>) =>
  Effect.forEach(Object.entries(sections).filter(([, s]) => s.path && s.enabled !== false), ([name, s]) =>
    bundled.includes(name) ? Effect.succeed({ name, error: `${name} is a bundled plugin's name` })
    : loadOne(name, s.path!).pipe(Effect.map((plugin) => ({ name, plugin })), Effect.catch((error) => Effect.succeed({ name, error }))),
  { concurrency: "unbounded" })
