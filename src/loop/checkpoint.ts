import { createHash } from "node:crypto"
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { myStart, processStart, withLock, writeAtomic } from "../base/files"
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
// `shared`: another run in the same folder ran during the turn (below), so some of what it changed may be that run's.
export type Checkpoint = { readonly root: string; readonly before: string; readonly after: string; readonly input: string; readonly shared?: boolean }
export const isTree = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{40,64}$/.test(s)

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

// A private copy of the repo's index (so `git add -A` only reads files that changed), removed on exit. Copied with its
// time (cp -p): git trusts a file's cached stat only if the file is older than the index, and a fresh copy's newer time
// would make a same-size edit right after the index was written look unchanged ("racy git").
const PRIVATE_INDEX = `idx=$(mktemp) && rm -f "$idx" && trap 'rm -f "$idx"' EXIT
cp -p "$(git rev-parse --path-format=absolute --git-path index)" "$idx" 2>/dev/null
export GIT_INDEX_FILE="$idx"`

// git as the snapshots and restores run it, with nothing the repo's own config can make run: no fsmonitor, no hooks,
// every configured filter's clean/smudge/process emptied and none required (Git LFS marks its filter required: left
// so, every snapshot failed). A turn can write .git/config (a filter whose clean is any command, with a .gitattributes
// line), and the snapshot runs on the host every turn, unasked. The overrides go through GIT_CONFIG_KEY_n/VALUE_n, the
// keys read NUL-separated, so no name is parsed again (a filter named "x=y" slipped through -c filter.x=y.clean=).
// Both sides run unfiltered, so a restore writes back exactly what the snapshot stored.
const SAFE_GIT = `safe_git() {
  local i=0 key
  while IFS= read -r -d "" key; do
    case "$key" in
      *.clean|*.smudge|*.process) export "GIT_CONFIG_KEY_$i=$key" "GIT_CONFIG_VALUE_$i="; i=$((i+1)) ;;
      *.required) export "GIT_CONFIG_KEY_$i=$key" "GIT_CONFIG_VALUE_$i=false"; i=$((i+1)) ;;
    esac
  done < <(git config -z --name-only --get-regexp '^filter\\.')
  export "GIT_CONFIG_KEY_$i=core.fsmonitor" "GIT_CONFIG_VALUE_$i="; i=$((i+1))
  export "GIT_CONFIG_KEY_$i=core.hooksPath" "GIT_CONFIG_VALUE_$i=/dev/null"; i=$((i+1))
  export GIT_CONFIG_COUNT=$i
}
safe_git
g() { git "$@"; }`

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
// `root`: the repo root, when it was just found (not asked of git again).
const allowed = () => Effect.succeed({ decision: "allow" as const })
export const snapshot = (cwd = process.cwd(), index?: string, root?: string) =>
  Effect.gen(function* () {
    const kept = index ? `[ -f ${quote(index)} ] || cp -p "$(git rev-parse --path-format=absolute --git-path index)" ${quote(index)} 2>/dev/null
export GIT_INDEX_FILE=${quote(index)}` : PRIVATE_INDEX
    const at = root ? `root=${quote(root)}` : `cd ${quote(cwd)} || exit 3
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 3`
    const out = yield* runBash(`${at}
cd "$root" || exit 3
${SAFE_GIT}
${kept}
g add -A . && echo "$root" && g write-tree`, 60_000, allowed)
    const [top, tree] = ok(out) ?? []
    return top && isTree(tree) ? { root: top, tree } : undefined
  }).pipe(Effect.orElseSucceed(() => undefined))

// Around a turn: its checkpoint if it changed the project's files, else undefined.
export const checkpointOf = (input: string, before: { root: string; tree: string } | undefined, after: { root: string; tree: string } | undefined, shared = false): Checkpoint | undefined =>
  before && after && before.root === after.root && before.tree !== after.tree ? { root: before.root, before: before.tree, after: after.tree, input, ...(shared ? { shared } : {}) } : undefined

// Several runs can work in one folder at once (the agent's sessions; all Telegram chats share one), each with its own
// process. Per repo, a file in the temp folder (gone at reboot, with the runs) says which runs are in a turn now (pid and
// start time, so a crashed one's entry is dropped) and counts every snapshot and /undo there; its lock keeps captures
// and restores from overlapping. A turn shared its folder if another run was in a turn when it started or ended, or the
// count moved past its own start in between.
// ponytail: edits another run made during the turn are counted as the turn's own, so /undo only warns; tracking each
// run's writes would tell them apart. Keyed by repo root, so worktrees of one repo don't see each other (they don't share files).
type Activity = { seq: number; active: Array<{ id: string; pid: number; startedAt: string }> }

const rootOf = (cwd: string) =>
  runBash(`cd ${quote(cwd)} && git rev-parse --show-toplevel`, 10_000, allowed).pipe(
    Effect.map((out) => ok(out)?.[0] || undefined),
    Effect.orElseSucceed(() => undefined),
  )

// Under the lock of `root`'s activity: `change` it (saved), then `use`. No root (not in git): just `use`.
const inFolder = <A, B, E, R>(root: string | undefined, change: (activity: Activity) => A, use: Effect.Effect<B, E, R>): Effect.Effect<readonly [A | undefined, B], E, R> => {
  if (!root) return Effect.map(use, (b) => [undefined, b] as const)
  const file = join(tmpdir(), "empty-vessel-folders", `${createHash("sha256").update(root).digest("hex")}.json`)

  return withLock(file, Effect.gen(function* () {
    const read = yield* Effect.promise(() => Bun.file(file).json().catch(() => undefined)) as Effect.Effect<Partial<Activity> | undefined>
    const activity: Activity = { seq: typeof read?.seq === "number" ? read.seq : 0, active: Array.isArray(read?.active) ? read.active : [] }
    activity.active = activity.active.filter((r) => processStart(r.pid) === r.startedAt) // a crashed run's entry goes

    const result = change(activity)
    yield* writeAtomic(file, JSON.stringify(activity))
    return [result, yield* use] as const
  }))
}

// A turn's snapshots in `cwd`: the one before (now), and `end`, the one after and whether another run shared the folder.
export const watchTurn = (cwd = process.cwd(), index?: string) =>
  Effect.gen(function* () {
    const root = yield* rootOf(cwd)
    const me = { id: crypto.randomUUID(), pid: process.pid, startedAt: myStart() }
    const [start, before] = yield* inFolder(root, (a) => {
      const others = a.active.length > 0
      a.active.push(me)
      return { seq: ++a.seq, others }
    }, snapshot(cwd, index, root))

    // The turn may have moved the repo (git init, a removed .git), so the after snapshot finds its root again.
    const end = inFolder(root, (a) => {
      const shared = !!start?.others || a.seq !== start?.seq || a.active.some((r) => r.id !== me.id)
      a.active = a.active.filter((r) => r.id !== me.id)
      a.seq++
      return shared
    }, snapshot(cwd, index)).pipe(Effect.map(([shared, after]) => ({ after, shared: shared ?? false })))

    return { before, end }
  })

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
      const moved = kind === "undo" ? move(checkpoint.root, checkpoint.before, checkpoint.after) : move(checkpoint.root, checkpoint.after, checkpoint.before)
      const [, done]: readonly [unknown, Undone] = yield* inFolder(checkpoint.root, (a) => { a.seq++ }, moved) // a run in a turn now sees it

      ;(done.failed ? from : to).push(checkpoint)
      const lines = [
        ...done.restored.map((p) => `- restored ${p}`), ...done.removed.map((p) => `- removed ${p}`),
        ...done.yours.map((p) => `- kept ${p}: it changed again after ${kind === "undo" ? "that turn" : "the undo"}`),
        ...done.ignored.map((p) => `- kept ${p}: ignored ${kind === "undo" ? "before" : "after"} that turn`),
        ...(done.stuck ?? []).map((p) => `- couldn't remove ${p}: remove it by hand if it shouldn't be there`),
      ]
      const what = `"${checkpoint.input.slice(0, 80)}"`
      const shared = checkpoint.shared ? "Another run in this folder ran during that turn, so some of these changes may be its: check them with git diff.\n" : ""
      reply = shared + (done.failed ? `Couldn't ${kind} ${what}: ${done.failed}.${lines.length ? `\n${lines.join("\n")}` : ""}` : `${kind === "undo" ? "Undid" : "Redid"} what ${what} changed:\n${lines.join("\n")}`)
      if (kind === "redo" && !done.failed) yield* session.record("checkpoint", checkpoint.before, { root: checkpoint.root, after: checkpoint.after, input: checkpoint.input, ...(checkpoint.shared ? { shared: true } : {}) }).pipe(Effect.ignore)
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
