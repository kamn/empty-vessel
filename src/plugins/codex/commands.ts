import { Console, Effect } from "effect"
import { codexAuthStore, CODEX_AUTH_FILE } from "./auth"
import { CodexAuthError, type CodexCredentials } from "./auth-store"
import { loginCodexBrowser, loginCodexDevice } from "./oauth"

type CommandsDependencies = {
  store: Pick<typeof codexAuthStore, "save" | "logout" | "status">
  browser: (onUrl: (url: string) => Effect.Effect<void, CodexAuthError>) => Effect.Effect<CodexCredentials, CodexAuthError>
  device: (onCode: (info: { url: string; code: string }) => Effect.Effect<void, CodexAuthError>) => Effect.Effect<CodexCredentials, CodexAuthError>
  print: (message: string) => Effect.Effect<void>
  open: (url: string) => Effect.Effect<void>
  file: string
}

// Browser launch is only a convenience: the printed URL works when no desktop is available.
const openBrowser = (url: string) => Effect.tryPromise({
  try: async (signal) => {
    const child = Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
    })
    const stop = () => child.kill()
    signal.addEventListener("abort", stop, { once: true })

    try {
      if (signal.aborted) child.kill()
      if (await child.exited !== 0) throw new Error("browser launch failed")
    } finally {
      signal.removeEventListener("abort", stop)
    }
  },
  catch: () => new CodexAuthError({ message: "Couldn't open a browser automatically." }),
}).pipe(
  Effect.timeout("5 seconds"),
  Effect.catch(() => Console.log("Open the URL above in your browser to finish signing in.")),
)

export const makeCodexAuthCommands = (deps: CommandsDependencies) => ({
  login: ({ deviceCode = false, status = false }: { deviceCode?: boolean; status?: boolean } = {}) => Effect.gen(function* () {
    if (deviceCode && status) return yield* Effect.fail(new CodexAuthError({ message: "Choose either --status or --device-code, not both." }))

    if (status) {
      const current = yield* deps.store.status
      if (current.source === "none") return yield* deps.print("Codex: not logged in. Run `empty-vessel login codex`.")

      const expiry = current.expires === undefined ? "unknown" : new Date(current.expires).toISOString()
      return yield* deps.print(current.source === "native"
        ? `Codex: independent empty-vessel login; access token expires ${expiry}. Tokens refresh automatically when needed.`
        : `Codex: read-only Codex CLI fallback; access token expires ${expiry}. Run \`empty-vessel login codex\` for independent login.`)
    }

    const credentials = yield* (deviceCode
      ? deps.device(({ url, code }) => deps.print(`Open ${url}\nEnter code: ${code}\nWaiting for authorization; press Ctrl+C to cancel.`))
      : deps.browser((url) => Effect.gen(function* () {
        yield* deps.print(`Open this URL to log in with ChatGPT:\n${url}\nWaiting for authorization; press Ctrl+C to cancel.`)
        yield* deps.open(url)
      })))

    yield* deps.store.save(credentials)
    yield* deps.print(`Independent Codex login saved to ${deps.file}. Codex CLI credentials were not changed.`)
  }),
  logout: deps.store.logout.pipe(Effect.andThen(deps.print("Logged out of Codex in empty-vessel. Codex CLI credentials were not changed; automatic fallback is disabled. Run `empty-vessel login codex` to reconnect."))),
})

const commands = makeCodexAuthCommands({
  store: codexAuthStore,
  browser: loginCodexBrowser,
  device: loginCodexDevice,
  print: Console.log,
  open: openBrowser,
  file: CODEX_AUTH_FILE,
})
export const codexLoginCommand = commands.login
export const codexLogoutCommand = commands.logout
