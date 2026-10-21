import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import type { SessionHandle } from "../base/session"
import { runBash } from "../tools/bash"
import { Kernel } from "../tools/kernel-service"
import type { Conversation } from "./turnkit"

// /undo: the project's files as they were before the last turn that changed them, as OpenCode's /undo and Claude Code's
// rewind do. Before and after each turn, the working tree (new files too, not ignored ones) is written to git as a tree
// object, through a private index: the user's index, branch and stash are never touched. A turn whose trees differ is a
// checkpoint. /undo takes back only what that turn changed (the paths that differ between its two trees): it restores the
// ones it changed or deleted and removes the ones it created, but leaves a path alone if it changed again since the turn
// ended (you edited it: yours to keep), or, for a file it would remove, if the ignore rules before the turn covered it
// (a .env that a rewritten .gitignore exposed: it wasn't the turn's). Only inside a git repo.
// Each checkpoint is recorded in the session (and each /undo, as how many are left), so a resumed session can undo too.
// ponytail: the trees are unreferenced git objects, so `git gc` can drop them after two weeks (an /undo then says git
// failed); pin them in refs/ if older undos matter.
export type Checkpoint = { readonly root: string; readonly before: string; readonly after: string; readonly input: string }
export const isTree = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{40,64}$/.test(s)

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

// A private copy of the repo's index (so `git add -A` only reads files that changed), removed on exit. Copied with its
// time (cp -p): git trusts a file's cached stat only if the file is older than the index, and a fresh copy's newer time
// would make a same-size edit right after the index was written look unchanged ("racy git").
const PRIVATE_INDEX = `idx=$(mktemp) && rm -f "$idx" && trap 'rm -f "$idx"' EXIT
cp -p "$(git rev-parse --path-format=absolute --git-path index)" "$idx" 2>/dev/null
export GIT_INDEX_FILE="$idx"`

// git as the snapshots and restores run it, with nothing the repo's own config can make run: no fsmonitor, no hooks,
// and every configured filter's clean/smudge/process emptied. A turn can write .git/config (a filter whose clean is any
// command, with a .gitattributes line), and the snapshot runs on the host every turn, unasked. Both sides run unfiltered,
// so a restore writes back exactly what the snapshot stored (a Git LFS file's content, not its pointer).
const SAFE_GIT = `g() { git -c core.fsmonitor= -c core.hooksPath=/dev/null $(git config --get-regexp '^filter\\..*\\.(clean|smudge|process)$' | awk '{print "-c " $1 "="}') "$@"; }`

// The output of a kernel command that exited 0, its lines; else undefined.
const ok = (out: string) => {
  const [status, ...lines] = out.split("\n")
  return status === "exit 0" ? lines : undefined
}

// The project at `cwd` as it is now (its root and tree), or undefined outside git (or if git fails: a turn must never
// fail over its checkpoint). Not through ActionGuard: it's the harness's own fixed, read-only bookkeeping, run twice a
// turn, not an action the agent proposed (an "ask" policy would otherwise ask the user to approve it each turn).
// /undo's restore, which changes files, still goes through the guard.
// `index`: a private index kept between turns (in the session's folder), so git's cache of file times holds for new
// files too and only what changed is read again; a fresh copy each turn re-read every untracked file every turn.
const allowed = () => Effect.succeed({ decision: "allow" as const })
export const snapshot = (cwd = process.cwd(), index?: string) =>
  Effect.gen(function* () {
    const kept = index ? `[ -f ${quote(index)} ] || cp -p "$(git rev-parse --path-format=absolute --git-path index)" ${quote(index)} 2>/dev/null
export GIT_INDEX_FILE=${quote(index)}` : PRIVATE_INDEX
    const out = yield* runBash(`cd ${quote(cwd)} || exit 3
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 3
cd "$root" || exit 3
${SAFE_GIT}
${kept}
g add -A . && echo "$root" && g write-tree`, 60_000, allowed)
    const [root, tree] = ok(out) ?? []
    return root && isTree(tree) ? { root, tree } : undefined
  }).pipe(Effect.orElseSucceed(() => undefined))

// Around a turn: its checkpoint if it changed the project's files, else undefined.
export const checkpointOf = (input: string, before: { root: string; tree: string } | undefined, after: { root: string; tree: string } | undefined): Checkpoint | undefined =>
  before && after && before.root === after.root && before.tree !== after.tree ? { root: before.root, before: before.tree, after: after.tree, input } : undefined

const nul = (text: string) => text.split("\0").filter(Boolean)

type Undone = { restored: Array<string>; removed: Array<string>; yours: Array<string>; ignored: Array<string>; stuck?: Array<string>; failed?: string }

// Move the paths that differ between `target` and `expected` from `expected` (what they should be now) back to `target`
// (see the top): /undo moves a turn's after to its before, /redo the other way. A path that no longer matches `expected`
// is left (yours). Lists go through files (paths can hold anything), and files are restored before anything is
// removed, so a failure leaves nothing deleted that wasn't put back.
const move = (root: string, target: string, expected: string) => {
  const work = mkdtempSync(join(tmpdir(), "empty-vessel-undo-")) // removed however this ends
  const file = (name: string) => quote(join(work, name))

  return Effect.gen(function* () {
    const kernel = yield* Kernel

    // What differs (target → expected), and what changed since (expected → now).
    const looked = yield* kernel.exec(`cd ${quote(root)} || exit 3
${SAFE_GIT}
${PRIVATE_INDEX}
g add -A . && now=$(g write-tree) || exit 4
g diff -z --name-status --no-renames ${target} ${expected} > ${file("turn")} || exit 5
g diff -z --name-only --no-renames ${expected} "$now" > ${file("since")} || exit 5`, 60_000)
    if (!ok(looked)) return { restored: [], removed: [], yours: [], ignored: [], failed: "git couldn't compare the files (nothing was changed)" } satisfies Undone

    const pairs = nul(readFileSync(join(work, "turn"), "utf8"))
    const since = new Set(nul(readFileSync(join(work, "since"), "utf8")))
    const turn = Array.from({ length: pairs.length / 2 }, (_, i) => ({ status: pairs[2 * i]!, path: pairs[2 * i + 1]! }))
    const yours = turn.filter((c) => since.has(c.path)).map((c) => c.path)
    const restored = turn.filter((c) => !since.has(c.path) && c.status !== "A").map((c) => c.path)
    const created = turn.filter((c) => !since.has(c.path) && c.status === "A").map((c) => c.path)
    writeFileSync(join(work, "restore"), restored.map((p) => `${p}\0`).join(""))
    writeFileSync(join(work, "created"), created.map((p) => `${p}\0`).join(""))

    // Restore first; then, under the restored ignore rules, which of the created files they cover.
    const put = yield* kernel.exec(`cd ${quote(root)} || exit 3
${SAFE_GIT}
${PRIVATE_INDEX}
g read-tree ${target} || exit 5
g checkout-index -f -z --stdin < ${file("restore")} || exit 6
g check-ignore -z --no-index --stdin < ${file("created")} > ${file("ignored")}; [ $? -le 1 ] || exit 7`, 60_000)
    if (!ok(put)) {
      const what = put.startsWith("exit 5") ? "git couldn't read the checkpoint (nothing was changed)" : "git failed while restoring: some files may be restored already, check git status"
      return { restored: [], removed: [], yours, ignored: [], failed: what } satisfies Undone
    }

    // A removal can fail where the restore just put something else at the path (a folder the turn had replaced with a
    // file, or a file it had replaced with a folder): then it's already right. Any other failure is kept and said.
    const ignored = new Set(nul(readFileSync(join(work, "ignored"), "utf8")))
    const removed: Array<string> = [], stuck: Array<string> = []

    for (const p of created.filter((p) => !ignored.has(p))) {
      try {
        rmSync(join(root, p), { force: true })
        removed.push(p)
      } catch {
        const there = (() => { try { return lstatSync(join(root, p)) } catch { return undefined } })()
        if (there && !there.isDirectory()) stuck.push(p)
      }
    }

    return { restored, removed, yours, ignored: created.filter((p) => ignored.has(p)), ...(stuck.length ? { stuck } : {}) } satisfies Undone
  }).pipe(Effect.ensuring(Effect.sync(() => rmSync(work, { recursive: true, force: true }))))
}

// /undo: back to before the last turn that changed files; /redo: forward again to after it (until a new turn changes
// files). Told to System Two with its next prompt, as a shared !command is. A failed one keeps its checkpoint, to try
// again. Recorded, so a resumed session has the same checkpoints (a redo records its checkpoint again).
const shift = (session: SessionHandle, conversation: Conversation, kind: "undo" | "redo") =>
  Effect.gen(function* () {
    const checkpoints = (conversation.checkpoints ??= []), redo = (conversation.redo ??= [])
    const [from, to] = kind === "undo" ? [checkpoints, redo] : [redo, checkpoints]
    const checkpoint = from.pop()
    let reply = kind === "undo"
      ? "Nothing to undo: no turn in this session changed files (only files in a git repo are tracked)."
      : "Nothing to redo: /redo goes forward after /undo, until a new turn changes files."

    if (checkpoint) {
      const done: Undone = yield* (kind === "undo" ? move(checkpoint.root, checkpoint.before, checkpoint.after) : move(checkpoint.root, checkpoint.after, checkpoint.before))
      ;(done.failed ? from : to).push(checkpoint)
      const lines = [
        ...done.restored.map((p) => `- restored ${p}`), ...done.removed.map((p) => `- removed ${p}`),
        ...done.yours.map((p) => `- kept ${p}: it changed again after ${kind === "undo" ? "that turn" : "the undo"}`),
        ...done.ignored.map((p) => `- kept ${p}: ignored ${kind === "undo" ? "before" : "after"} that turn`),
        ...(done.stuck ?? []).map((p) => `- couldn't remove ${p}: remove it by hand if it shouldn't be there`),
      ]
      const what = `"${checkpoint.input.slice(0, 80)}"`
      reply = done.failed ? `Couldn't ${kind} ${what}: ${done.failed}.${lines.length ? `\n${lines.join("\n")}` : ""}` : `${kind === "undo" ? "Undid" : "Redid"} what ${what} changed:\n${lines.join("\n")}`
      if (kind === "redo" && !done.failed) yield* session.record("checkpoint", checkpoint.before, { root: checkpoint.root, after: checkpoint.after, input: checkpoint.input }).pipe(Effect.ignore)
    }

    if (kind === "undo") yield* session.record("undone", String(checkpoints.length)).pipe(Effect.ignore) // what's left, for resume
    const user = `/${kind}`
    conversation.history.push({ user, answer: reply })
    conversation.unseen.push({ user, answer: reply })
    yield* session.record("user", user).pipe(Effect.ignore)
    yield* session.record("assistant", reply).pipe(Effect.ignore)
    return reply
  })

export const undoCommand = (session: SessionHandle, conversation: Conversation) => shift(session, conversation, "undo")
export const redoCommand = (session: SessionHandle, conversation: Conversation) => shift(session, conversation, "redo")
