import { Effect } from "effect"
import { type PluginSetup } from "empty-vessel"

// Logged in to Claude Code? `claude auth status` says, without calling a model.
const loggedIn = Effect.sync(() => {
  const r = Bun.spawnSync(["claude", "auth", "status", "--json"], { stdout: "pipe", stderr: "ignore", timeout: 20_000 })
  try { return JSON.parse(r.stdout.toString()).loggedIn === true } catch { return false }
})

// What Claude needs: Claude Code, logged in (System Two runs as `claude -p`, in empty-vessel's kernel).
export const setup: PluginSetup = {
  name: "claude",
  kind: "systemTwo",
  title: "Claude, through Claude Code",
  about: "https://claude.com/claude-code",
  checks: [
    { what: "Claude Code", ok: Effect.sync(() => Bun.which("claude") !== null), fix: "install it: https://claude.com/claude-code" },
    { what: "logged in to Claude Code", ok: loggedIn, fix: "run `claude auth login`, then `empty-vessel setup` again" },
  ],
}
