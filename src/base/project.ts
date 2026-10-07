import { join } from "node:path"
import { EMPTY_VESSEL_HOME } from "./home"

// Where empty-vessel keeps a project's data (checks, notes): one folder per repo, named after its path (like Claude Code's project folders).
// The repo is found through its shared .git folder, so every worktree of one repo shares the same checks.
export const projectDir = (root: string, home = EMPTY_VESSEL_HOME) => {
  const git = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const top = git.exitCode === 0 ? git.stdout.toString().trim().replace(/\/\.git$/, "") : root
  return join(home, "projects", top.replace(/[^A-Za-z0-9]/g, "-"))
}
