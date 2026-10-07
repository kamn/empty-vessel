import { homedir } from "node:os"
import { join } from "node:path"
import { EMPTY_VESSEL_HOME } from "../../base/home"
import { makeCodexAuthStore } from "./auth-store"
import { refreshCodexCredentials } from "./oauth"

// Native credentials are separate from both Codex CLI and remote tool-source logins.
// Legacy credentials remain a read-only fallback until native login or logout takes ownership.
export const CODEX_AUTH_FILE = join(EMPTY_VESSEL_HOME, "providers", "codex.json")
export const codexAuthStore = makeCodexAuthStore({
  file: CODEX_AUTH_FILE,
  legacyFile: join(homedir(), ".codex", "auth.json"),
  refresh: refreshCodexCredentials,
})

export const readCodexAuth = codexAuthStore.read
