import { basename } from "node:path"
import { Effect } from "effect"
import { Kernel } from "../tools/kernel-service"

// Asking before widening the scope: a turn's changes to the project
// are watched (git status, through the kernel: bash can change files too), and grouped into areas. A path's area is the
// nearest folder below the repo root with a package manifest, else its top-level folder ("." for files at the root).
// The areas of the turn's first changes are where it started; when changes reach another area, the next tool result
// tells System Two to ask the user first. Each new area is said once a turn: after that it's System Two's call (it asked,
// or nobody could answer). Only changes made this turn count: files already changed when it began are left out.
// ponytail: a file already changed before the turn and changed again isn't seen; compare contents if that matters.

const MANIFESTS = new Set(["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "setup.py", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "deno.json", "mix.exs", "pubspec.yaml"])

// The area a changed path belongs to, given the repo's manifests (their paths, from its root).
export const areaOf = (path: string, manifests: ReadonlySet<string>) => {
  const folders = path.split("/").slice(0, -1)
  for (let n = folders.length; n > 0; n--) {
    const dir = folders.slice(0, n).join("/")
    if ([...MANIFESTS].some((m) => manifests.has(`${dir}/${m}`))) return dir
  }
  return folders[0] ?? "."
}

// The repo's root and the paths git reports as changed (new files too), or undefined outside a git repo.
// `git status -z`: each entry "XY path", a rename's or copy's original path as the next entry.
const changed = Effect.gen(function* () {
  const out = yield* (yield* Kernel).exec("git rev-parse --show-toplevel && git status --porcelain -z -uall", 20_000)
  const [status, root, ...rest] = out.split("\n")
  if (status !== "exit 0" || !root) return undefined

  const entries = rest.join("\n").replace(/^\(no output\)$/, "").split("\0").filter(Boolean)
  const paths: Array<string> = []
  for (let i = 0; i < entries.length; i++) {
    paths.push(entries[i]!.slice(3))
    if (/^[RC]/.test(entries[i]!)) i++
  }
  return { root, paths }
})

type Watch = { readonly before: ReadonlySet<string>; readonly manifests: ReadonlySet<string>; started?: ReadonlySet<string>; readonly said: Set<string> }
const watches = new WeakMap<object, Watch>()

// At the start of a turn's work (once per turn: `turn` is its state): what's already changed, the repo's manifests, and
// where the work starts: the areas the request names (a package's folder in its words); if it names none, the areas of
// its first changes. Not the files gathered for it: those are for reading (the cause can be in another package), not a
// say on what to change.
export const watchScope = (turn: object, request: string) =>
  Effect.gen(function* () {
    if (watches.has(turn)) return
    const now = yield* changed
    if (!now) return

    const listed = yield* (yield* Kernel).files.list(now.root)
    const manifests = new Set(listed.filter((p) => MANIFESTS.has(basename(p))))
    const named = new Set([...manifests].map((m) => m.slice(0, m.lastIndexOf("/"))).filter((dir) => dir && request.includes(dir)))
    watches.set(turn, { before: new Set(now.paths), manifests, ...(named.size ? { started: named } : {}), said: new Set() })
  })

// After a tool call: a note for System Two if this turn's changes reached an area it didn't start in (and wasn't told
// about yet), else undefined.
export const scopeNote = (turn: object) =>
  Effect.gen(function* () {
    const watch = watches.get(turn)
    const now = watch ? yield* changed : undefined
    if (!watch || !now) return undefined

    const mine = now.paths.filter((p) => !watch.before.has(p))
    if (!mine.length) return undefined
    const byArea = Map.groupBy(mine, (p) => areaOf(p, watch.manifests))
    watch.started ??= new Set(byArea.keys())

    const fresh = [...byArea].filter(([area]) => !watch.started!.has(area) && !watch.said.has(area))
    if (!fresh.length) return undefined
    for (const [area] of fresh) watch.said.add(area)

    const where = fresh.map(([area, files]) => `${area} (${files.slice(0, 3).join(", ")}${files.length > 3 ? `, ${files.length - 3} more` : ""})`).join("; ")
    return `[Scope: this work started in ${[...watch.started].join(", ")}, and these changes reach another part of the project: ${where}. That may be another package or service that ships on its own. Unless the user asked for it, ask them (ask_user) before changing anything more there; if no one can answer, stop and say what's needed, and in your answer say what you already changed there.]`
  })
