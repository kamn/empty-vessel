import { join } from "node:path"
import { Context, Effect } from "effect"
import { makeKernel } from "../kernel/kernel"
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

// Application bridge, not part of the generic kernel. Capture each run's services before the
// Worker's callback crosses into a fresh fiber, so guards and the active approval UI are preserved.
export const makeGuardedKernel: typeof makeKernel = (options) => {
  const kernel = makeKernel(options)

  return {
    ...kernel,
    run: (code, host = {}, title) => Effect.gen(function* () {
      const services = yield* Effect.context<never>()
      const authorize = (input: unknown) => Effect.suspend(() => {
        if (!input || typeof input !== "object") return Effect.fail(new Error("Invalid action request"))
        const action = input as Partial<Action>

        if (action.kind !== "shell" || typeof action.command !== "string" || action.cwd !== process.cwd()
          || typeof action.timeoutMs !== "number" || !Number.isFinite(action.timeoutMs) || action.timeoutMs <= 0) {
          return Effect.fail(new Error("Invalid action request"))
        }

        return authorizeAction({ kind: "shell", command: action.command, cwd: action.cwd, timeoutMs: action.timeoutMs })
      }).pipe(Effect.provideContext(services))

      // Reserved: a supplied host function must not replace the authorization boundary.
      return yield* kernel.run(code, { ...host, $actionGuard: authorize }, title)
    }),
  }
}

export const Kernel = Context.Reference<KernelService>("empty-vessel/Kernel", { defaultValue: () => ({ open: makeGuardedKernel, exec: runBash, files: localFiles }) })
