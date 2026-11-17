import { readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { EMPTY_VESSEL_HOME } from "./home"

// The repo's shared .git folder (every worktree of a repo has the same one), or undefined outside a repo: what
// `git rev-parse --git-common-dir` prints, read from the files git reads. Not asked of git: Bun.spawnSync (1.4.2, macOS)
// now and then misses its child's exit and spins for good (a turn, or a test worker, stuck at 100% CPU), and this runs
// on every project memory read.
// ponytail: a bare repo and $GIT_DIR aren't seen as repos (the folder itself is then the project).
const commonDir = (root: string) => {
  let dir: string
  try { dir = realpathSync(root) } catch { return undefined }

  for (;; dir = dirname(dir)) {
    const dot = join(dir, ".git"), kind = statSync(dot, { throwIfNoEntry: false })
    if (kind?.isDirectory() && statSync(join(dot, "HEAD"), { throwIfNoEntry: false })) return dot

    // A worktree's .git is a file naming its own folder inside the repo's .git, whose `commondir` leads back to it.
    if (kind?.isFile()) {
      const own = resolve(dir, readFileSync(dot, "utf8").replace(/^gitdir: /, "").trim())
      const common = statSync(join(own, "commondir"), { throwIfNoEntry: false })
      return common ? resolve(own, readFileSync(join(own, "commondir"), "utf8").trim()) : own
    }

    if (dir === dirname(dir)) return undefined
  }
}

// Where empty-vessel keeps a project's data (checks, notes): one folder per repo, named after its path (like Claude Code's project folders).
// The repo is found through its shared .git folder, so every worktree of one repo shares the same checks.
export const projectDir = (root: string, home = EMPTY_VESSEL_HOME) => {
  const top = commonDir(root)?.replace(/\/\.git$/, "") ?? root
  return join(home, "projects", top.replace(/[^A-Za-z0-9]/g, "-"))
}
