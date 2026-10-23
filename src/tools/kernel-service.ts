import { join } from "node:path"
import { Context, Effect } from "effect"
import { CurrentSession } from "../base/session"
import { type BeforeCall, makeKernel } from "../kernel/kernel"
import { runBash } from "./bash"
import { authorizeAction, type Action } from "./action-guard"

// The world empty-vessel works in: a kernel for cells in a folder, a command where the cells'
// files are, and those files read. Every action on the project goes through here (System Two's cells, System One's tool
// runs, checks and Gather, promote's and adoption's trial runs, the reviewer's check runs, the user's !command), so
// another kernel (a container, Deno, a microVM) is one replacement, not a hunt through the loop. The default is today's:
// cells in a Bun Worker in this process, commands and files on this machine. A Reference: nothing has to provide it.
// ponytail: one implementation, so no `kernel.use` or plugin kind yet; add them with the second kernel.
export type KernelService = {
  readonly open: typeof makeKernel
  readonly exec: (command: string, timeoutMs: number) => ReturnType<typeof runBash>
  readonly files: ProjectFiles
}

// The project as empty-vessel's own looks at it read it (System One's Gather, packing files for System Two's prompt): the same
// files the cells see, so both systems look at one world. Paths are relative to `root`; none of these fails (an
// unreadable file reads as undefined, a list or search that can't run as empty).
export type ProjectFiles = {
  readonly list: (root: string) => Effect.Effect<ReadonlyArray<string>> // what git tracks; outside git, all but .git/ and node_modules/
  readonly grep: (root: string, word: string) => Effect.Effect<ReadonlyArray<string>> // files containing it, any case
  readonly read: (root: string, path: string) => Effect.Effect<string | undefined>
  readonly size: (root: string, path: string) => Effect.Effect<number>
}

// This machine's files, as they are.
const localFiles: ProjectFiles = {
  list: (root) => Effect.promise(async () => {
    const git = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe", stderr: "pipe" })
    if (git.exitCode === 0) return git.stdout.toString().split("\0").filter(Boolean)
    const found: Array<string> = [] // ponytail: scans node_modules before skipping it; fine outside git, rare for us
    try {
      for await (const path of new Bun.Glob("**/*").scan({ cwd: root, dot: true, onlyFiles: true }))
        if (!/(^|\/)(\.git|node_modules)\//.test(path)) found.push(path)
    } catch {} // an unreadable folder: keep what was found
    return found
  }),
  grep: (root, word) => Effect.sync(() => {
    const r = Bun.spawnSync(["git", "grep", "-l", "-i", "-F", "-e", word], { cwd: root, stdout: "pipe", stderr: "pipe" })
    return r.exitCode === 0 ? r.stdout.toString().split("\n").filter(Boolean) : []
  }),
  read: (root, path) => Effect.promise(() => Bun.file(join(root, path)).text().catch(() => undefined)),
  size: (root, path) => Effect.sync(() => Bun.file(join(root, path)).size),
}

// What each built-in does to the world, for the effect journal. A harmless one (reading, the clock, model calls, a cache)
// can run again after a crash; before an effectful one (writing, commands, sub-agents, the library, memory) runs, the
// session records that it is about to (an `effect` entry), so a cell that may have done it isn't run again. Host
// functions go by their built-in's name. A name not here (a new built-in) counts as effectful. The services and layers
// are harmless themselves: what they do goes through the built-ins above them. Tool sources ($source) go by each tool's
// readOnlyHint; $actionGuard (bash) and $effect (write, edit) record their own.
export const EFFECTS: Readonly<Record<string, "harmless" | "effectful">> = {
  Files: "harmless", Shell: "harmless", SystemOne: "harmless", Agents: "harmless", Library: "harmless", Time: "harmless", Random: "harmless", Sources: "harmless", layerFor: "harmless", layer: "harmless",
  read: "harmless", readText: "harmless", skill: "harmless", now: "harmless", random: "harmless", systemOne: "harmless", recheck: "harmless", fill: "harmless", judge: "harmless",
  wait: "harmless", jobs: "harmless", tools: "harmless", pastSessions: "harmless", remember: "harmless", forget: "harmless", // forget drops a cache: doing it twice is the same
  write: "effectful", edit: "effectful", bash: "effectful", spawn: "effectful", cancel: "effectful", promote: "effectful", handTools: "effectful", memory: "effectful",
  $source: "effectful", $actionGuard: "effectful", $effect: "effectful",
}
export const effectful = (name: string) => EFFECTS[name] !== "harmless"

// Application bridge, not part of the generic kernel. Capture each run's services before the
// Worker's callback crosses into a fresh fiber, so guards and the active approval UI are preserved.
export const makeGuardedKernel: typeof makeKernel = (options) => {
  const kernel = makeKernel(options)

  return {
    ...kernel,
    run: (code, host = {}, title, before) => Effect.gen(function* () {
      const services = yield* Effect.context<never>()
      const session = yield* CurrentSession
      const at = { cell: kernel.cells().length + 1, kernel: options.dir } // the number kernel.run takes next

      // An effect entry: an intent (synced, so a crash right after can't lose it), or an intent's outcome. Outside a
      // turn (no session), nothing to record. A failed record fails the call, so what it was for doesn't happen.
      const note = (text: string, extra: Readonly<Record<string, unknown>>, sync = true) =>
        (session ? session.record("effect", text, { ...at, ...extra }, { sync }) : Effect.void).pipe(Effect.provideContext(services))
      const intent = (text: string) => Effect.suspend(() => {
        const id = crypto.randomUUID()
        return note(text, { id }).pipe(Effect.as(id))
      })

      // write and edit (in the cell's Worker) ask before acting and report after. Only intents this cell made get an outcome.
      const issued = new Map<string, string>()
      const effect = (input: unknown) => Effect.suspend(() => {
        const e = (input ?? {}) as { tool?: unknown; path?: unknown; id?: unknown; outcome?: unknown }

        if (typeof e.id === "string" && issued.has(e.id)) {
          const text = issued.get(e.id)!
          issued.delete(e.id)
          return note(text, { id: e.id, outcome: String(e.outcome).slice(0, 500) }, false).pipe(Effect.as("recorded"))
        }

        if ((e.tool === "write" || e.tool === "edit") && typeof e.path === "string") {
          const text = `${e.tool} ${e.path}`
          return intent(text).pipe(Effect.tap((id) => Effect.sync(() => { issued.set(id, text) })))
        }

        return Effect.fail(new Error("Invalid effect record"))
      })

      // Host built-ins and tool sources, before each call: effectful ones recorded (bash and write/edit record their own).
      const journal: BeforeCall = (fn, arg) => Effect.gen(function* () {
        if (fn === "$actionGuard" || fn === "$effect") return

        if (fn === "$source") {
          const { source, tool, args } = (arg ?? {}) as { source?: string; tool?: string; args?: unknown }
          const tools = yield* (options.sources?.find((s) => s.name === source)?.list ?? Effect.succeed([])).pipe(Effect.orElseSucceed(() => []))
          if (tools.find((t) => t.name === tool)?.readOnlyHint === true) return
          return yield* intent(`${source}.${tool} ${(JSON.stringify(args) ?? "").slice(0, 500)}`)
        }

        if (effectful(fn)) yield* intent(`${fn} ${(JSON.stringify(arg) ?? "").slice(0, 500)}`)
      }).pipe(Effect.andThen(before ? before(fn, arg) : Effect.void))

      const authorize = (input: unknown) => Effect.suspend(() => {
        if (!input || typeof input !== "object") return Effect.fail(new Error("Invalid action request"))
        const action = input as Partial<Action>

        if (action.kind !== "shell" || typeof action.command !== "string" || action.cwd !== process.cwd()
          || typeof action.timeoutMs !== "number" || !Number.isFinite(action.timeoutMs) || action.timeoutMs <= 0) {
          return Effect.fail(new Error("Invalid action request"))
        }

        // Allowed: recorded before the command runs.
        return authorizeAction({ kind: "shell", command: action.command, cwd: action.cwd, timeoutMs: action.timeoutMs }).pipe(
          Effect.tap((verdict) => (verdict.decision === "allow" ? intent(`bash ${action.command}`) : Effect.void)),
        )
      }).pipe(Effect.provideContext(services))

      // Reserved: a supplied host function must not replace the authorization boundary or the journal.
      return yield* kernel.run(code, { ...host, $actionGuard: authorize, $effect: effect }, title, journal)
    }),
  }
}

export const Kernel = Context.Reference<KernelService>("empty-vessel/Kernel", { defaultValue: () => ({ open: makeGuardedKernel, exec: runBash, files: localFiles }) })
