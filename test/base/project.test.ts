import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectDir } from "../../src/base/project"

const named = (path: string) => join("home", "projects", path.replace(/[^A-Za-z0-9]/g, "-"))

test("a repo, a folder inside it and its worktrees share one project folder; outside a repo, the folder is the project", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "empty-vessel-project-")))
  const repo = join(base, "repo"), worktree = join(base, "wt"), plain = join(base, "plain")
  mkdirSync(join(repo, ".git", "worktrees", "wt"), { recursive: true })
  mkdirSync(join(repo, "src"))
  mkdirSync(worktree)
  mkdirSync(plain)
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n")
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`)
  writeFileSync(join(repo, ".git", "worktrees", "wt", "commondir"), "../..\n")

  expect(projectDir(repo, "home")).toBe(named(repo))
  expect(projectDir(join(repo, "src"), "home")).toBe(named(repo))
  expect(projectDir(worktree, "home")).toBe(named(repo))
  expect(projectDir(plain, "home")).toBe(named(plain))
  expect(projectDir(join(base, "missing"), "home")).toBe(named(join(base, "missing")))
})

test("the same folder git names, for this checkout (so existing project folders keep their names)", () => {
  const git = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim()
  expect(projectDir(process.cwd(), "home")).toBe(named(git.replace(/\/\.git$/, "")))
})
