import { Effect } from "effect"
import type { SessionHandle } from "../base/session"
import { runBash } from "../tools/bash"
import { Kernel } from "../tools/kernel-service"
import type { Conversation } from "./turnkit"

// /undo: the project's files as they were before the last turn that changed them, as OpenCode's /undo and Claude Code's
// rewind do. Before each turn, the working tree (new files too, not ignored ones) is written to git as a tree object,
// through a temporary index: the user's index, branch and stash are never touched. /undo puts back the files that turn
// changed and removes the ones it created. Only inside a git repo; elsewhere there's nothing to undo.
// Each checkpoint is recorded in the session (and each /undo, as how many are left), so a resumed session can undo too.
// ponytail: the trees are unreferenced git objects, so `git gc` can drop them after two weeks (an /undo then says git
// failed); pin them in refs/ if older undos matter.
export type Checkpoint = { readonly root: string; readonly tree: string; readonly input: string }

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

// A private copy of the repo's index (so `git add -A` only reads files that changed), removed on exit.
const PRIVATE_INDEX = `idx=$(mktemp) && rm -f "$idx" && trap 'rm -f "$idx"' EXIT
cp "$(git rev-parse --path-format=absolute --git-path index)" "$idx" 2>/dev/null
export GIT_INDEX_FILE="$idx"`

// The output of a kernel command that exited 0, its lines; else undefined.
const ok = (out: string) => {
  const [status, ...lines] = out.split("\n")
  return status === "exit 0" ? lines : undefined
}

// The project at `cwd` as it is now, or undefined outside git (or if git fails: a turn must never fail over its
// checkpoint). Not through ActionGuard: it's the harness's own fixed, read-only bookkeeping, run every turn, not an
// action the agent proposed (an "ask" policy would otherwise ask the user to approve it each turn). /undo's restore,
// which changes files, still goes through the guard.
const allowed = () => Effect.succeed({ decision: "allow" as const })
export const snapshot = (input: string, cwd = process.cwd()) =>
  Effect.gen(function* () {
    const out = yield* runBash(`cd ${quote(cwd)} || exit 3
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 3
cd "$root" || exit 3
${PRIVATE_INDEX}
git add -A . && echo "$root" && git write-tree`, 60_000, allowed)
    const [root, tree] = ok(out) ?? []
    return root && tree && /^[0-9a-f]{40,64}$/.test(tree) ? { root, tree, input } satisfies Checkpoint : undefined
  }).pipe(Effect.orElseSucceed(() => undefined))

// Put the files back as they were at `checkpoint`: "same" if nothing changed since, else git's name-status lines of what
// changed since (A: created since, now removed; M and D: changed or deleted since, now restored).
const restore = ({ root, tree }: Checkpoint) =>
  Effect.gen(function* () {
    const out = yield* (yield* Kernel).exec(`cd ${quote(root)} || exit 3
${PRIVATE_INDEX}
git add -A . && now=$(git write-tree) || exit 4
[ "$now" = ${tree} ] && { echo same; exit 0; }
git diff --name-status --no-renames ${tree} "$now"
git diff --name-only -z --no-renames --diff-filter=A ${tree} "$now" | xargs -0 rm -f --
git read-tree ${tree} || exit 5
git diff --name-only -z --no-renames --diff-filter=MDT ${tree} "$now" | git checkout-index -f -z --stdin`, 60_000)
    return ok(out)?.filter((l) => l && l !== "(no output)")
  })

// /undo: back to before the last turn that changed files (turns that changed nothing are skipped), told to System Two
// with its next prompt, as a shared !command is.
export const undoCommand = (session: SessionHandle, conversation: Conversation) =>
  Effect.gen(function* () {
    const checkpoints = (conversation.checkpoints ??= [])
    let reply = "Nothing to undo: no turn in this session changed files (only files in a git repo are tracked)."

    while (checkpoints.length) {
      const checkpoint = checkpoints.pop()!
      const changes = yield* restore(checkpoint)
      if (!changes) { reply = `Couldn't undo: git failed in ${checkpoint.root}. Nothing was changed.`; break }
      if (changes[0] === "same") continue

      const words: Record<string, string> = { A: "removed", M: "restored", D: "restored", T: "restored" }
      const files = changes.map((l) => `- ${words[l[0]!] ?? "restored"} ${l.slice(2)}`)
      reply = `Undid the changes since before "${checkpoint.input.slice(0, 80)}":\n${files.join("\n")}`
      break
    }

    yield* session.record("undone", String(checkpoints.length)).pipe(Effect.ignore) // what's left, for resume
    const user = "/undo"
    conversation.history.push({ user, answer: reply })
    conversation.unseen.push({ user, answer: reply })
    yield* session.record("user", user).pipe(Effect.ignore)
    yield* session.record("assistant", reply).pipe(Effect.ignore)
    return reply
  })
