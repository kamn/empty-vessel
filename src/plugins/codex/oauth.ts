import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { Deferred, Effect } from "effect"
import { CodexAuthError, type CodexCredentials } from "./auth-store"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const fail = (message: string) => new CodexAuthError({ message })
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const bounded = (value: number | undefined, fallback: number, max: number) =>
  value !== undefined && Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback

export interface CodexOAuthOptions {
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  now?: () => number
  sleep?: (milliseconds: number) => Effect.Effect<void>
  /** Zero chooses an ephemeral loopback port, for tests only. */
  port?: number
  requestTimeoutMs?: number
  loginTimeoutMs?: number
}

// JWT claims are unverified metadata, not proof of identity or signature validation.
function accountId(access: string): string | undefined {
  try {
    const parts = access.split(".")
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"))
    if (!record(payload)) return
    const auth = payload["https://api.openai.com/auth"]
    const id = record(auth) ? auth.chatgpt_account_id : undefined
    return text(id) ? id : undefined
  } catch { return undefined }
}

export function makeCodexOAuth(options: CodexOAuthOptions = {}) {
  const http = options.fetch ?? ((url, init) => fetch(url, init))
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms) => Effect.sleep(ms))
  const requestTimeout = bounded(options.requestTimeoutMs, 30_000, 60_000)
  const loginTimeout = bounded(options.loginTimeoutMs, 15 * 60_000, 15 * 60_000)
  const timeout = <A>(effect: Effect.Effect<A, CodexAuthError>, duration: number) =>
    effect.pipe(Effect.timeoutOrElse({ duration, orElse: () => Effect.fail(fail("Codex authentication timed out")) }))

  // The controller lives through body consumption, and is aborted on every exit.
  const request = (path: string, body: URLSearchParams | Record<string, string>, pending = false) => timeout(Effect.scoped(Effect.gen(function* () {
    const controller = yield* Effect.acquireRelease(Effect.sync(() => new AbortController()), (c) => Effect.sync(() => c.abort()))
    const response = yield* Effect.tryPromise({
      try: () => http(`${ISSUER}${path}`, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json" },
        body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body),
        signal: controller.signal,
      }),
      catch: () => fail("Codex authentication request failed"),
    })

    if (pending && (response.status === 403 || response.status === 404)) return undefined
    if (!response.ok) return yield* Effect.fail(fail("Codex authentication request rejected"))
    const value = yield* Effect.tryPromise({ try: () => response.json() as Promise<unknown>, catch: () => fail("Invalid Codex authentication response") })
    if (!record(value)) return yield* Effect.fail(fail("Invalid Codex authentication response"))
    return value
  })), requestTimeout)

  const tokens = (body: URLSearchParams, previousRefresh?: string): Effect.Effect<CodexCredentials, CodexAuthError> => Effect.gen(function* () {
    const value = yield* request("/oauth/token", body)
    if (!value || !text(value.access_token) || typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0) {
      return yield* Effect.fail(fail("Invalid Codex token response"))
    }
    const refresh = Object.hasOwn(value, "refresh_token") ? value.refresh_token : previousRefresh
    const id = accountId(value.access_token)
    const current = now()
    const expires = current + value.expires_in * 1000

    if (!text(refresh) || !id || !Number.isFinite(current) || !Number.isFinite(expires) || expires <= current) {
      return yield* Effect.fail(fail("Invalid Codex token metadata"))
    }
    return { access: value.access_token, refresh, expires, accountId: id }
  })
  const exchange = (code: string, verifier: string, redirect: string) => tokens(new URLSearchParams({
    grant_type: "authorization_code", client_id: CLIENT_ID, code, code_verifier: verifier, redirect_uri: redirect,
  }))

  const refreshCodexCredentials = (credentials: CodexCredentials): Effect.Effect<CodexCredentials, CodexAuthError> => Effect.suspend(() =>
    text(credentials.refresh)
      ? tokens(new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: credentials.refresh }), credentials.refresh)
      : Effect.fail(fail("Invalid Codex refresh credentials")))

  const loginCodexBrowser = (onUrl: (url: string) => Effect.Effect<void, CodexAuthError>): Effect.Effect<CodexCredentials, CodexAuthError> => timeout(Effect.scoped(Effect.gen(function* () {
    const verifier = randomBytes(32).toString("base64url")
    const state = randomBytes(32).toString("base64url")
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    const callback = yield* Deferred.make<string, CodexAuthError>()
    const server = yield* Effect.acquireRelease(Effect.sync(() => createServer((req, res) => {
      let url: URL
      try { url = new URL(req.url ?? "/", "http://localhost") }
      catch { res.writeHead(400).end(); return }
      if (url.pathname !== "/auth/callback") { res.writeHead(404).end(); return }
      // Unrelated local requests cannot consume this login attempt. Only its state owns it.
      if (req.method !== "GET" || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== state) {
        res.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Invalid authorization callback.")
        return
      }

      let error: string | undefined
      const code = url.searchParams.get("code")
      if (url.searchParams.has("error")) error = "Codex authorization denied"
      else if (!text(code) || url.searchParams.getAll("code").length !== 1) error = "Missing Codex authorization code"
      res.writeHead(error ? 400 : 200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end(error ? "Authentication failed. Return to the terminal." : "Authorization received. Return to the terminal.")
      Deferred.doneUnsafe(callback, error ? Effect.fail(fail(error)) : Effect.succeed(code!))
    })), (server) => Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void))
      server.closeAllConnections()
    }))

    yield* Effect.callback<void, CodexAuthError>((resume) => {
      server.on("error", () => {
        const error = fail("Unable to listen for Codex OAuth on loopback. Finish any other login, or run `empty-vessel login codex --device-code`.")
        Deferred.doneUnsafe(callback, Effect.fail(error))
        resume(Effect.fail(error))
      })
      server.listen(options.port ?? 1455, "127.0.0.1", () => resume(Effect.void))
    })
    const address = server.address()
    if (!address || typeof address === "string") return yield* Effect.fail(fail("Invalid Codex callback listener"))
    const redirect = `http://localhost:${address.port}/auth/callback`
    const url = new URL(`${ISSUER}/oauth/authorize`)
    url.search = new URLSearchParams({
      response_type: "code", client_id: CLIENT_ID, redirect_uri: redirect,
      scope: "openid profile email offline_access", code_challenge: challenge, code_challenge_method: "S256",
      state, id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "empty-vessel",
    }).toString()

    yield* onUrl(url.toString())
    const code = yield* Deferred.await(callback)
    return yield* exchange(code, verifier, redirect)
  })), loginTimeout)

  const loginCodexDevice = (onCode: (info: { url: string; code: string }) => Effect.Effect<void, CodexAuthError>): Effect.Effect<CodexCredentials, CodexAuthError> => timeout(Effect.gen(function* () {
    const device = yield* request("/api/accounts/deviceauth/usercode", { client_id: CLIENT_ID })
    const interval = typeof device?.interval === "string" && device.interval.trim() !== "" ? Number(device.interval) : device?.interval
    if (!device || !text(device.device_auth_id) || !text(device.user_code) || typeof interval !== "number" || !Number.isFinite(interval) || interval < 0) {
      return yield* Effect.fail(fail("Invalid Codex device response"))
    }
    const expiry = device.expires_in ?? 900
    if (typeof expiry !== "number" || !Number.isFinite(expiry) || expiry <= 0) return yield* Effect.fail(fail("Invalid Codex device expiry"))
    const duration = Math.min(expiry * 1000, loginTimeout)
    const started = now()
    if (!Number.isFinite(started)) return yield* Effect.fail(fail("Invalid Codex authentication clock"))
    const deadline = started + duration
    // Do not poll faster than the issuer requested, even for unusually long intervals.
    const pollMs = Math.min(duration, Math.max(1000, interval * 1000))
    return yield* timeout(Effect.gen(function* () {
      yield* onCode({ url: `${ISSUER}/codex/device`, code: device.user_code as string })

      while (true) {
        yield* sleep(pollMs)
        if (!Number.isFinite(now()) || now() >= deadline) return yield* Effect.fail(fail("Codex device code expired"))
        const result = yield* request("/api/accounts/deviceauth/token", { device_auth_id: device.device_auth_id as string, user_code: device.user_code as string }, true)
        if (!result) continue
        if (!text(result.authorization_code) || !text(result.code_verifier)) return yield* Effect.fail(fail("Invalid Codex device authorization response"))
        return yield* exchange(result.authorization_code, result.code_verifier, `${ISSUER}/deviceauth/callback`)
      }
    }), duration)
  }), loginTimeout)

  return { refreshCodexCredentials, loginCodexBrowser, loginCodexDevice }
}

export const { refreshCodexCredentials, loginCodexBrowser, loginCodexDevice } = makeCodexOAuth()
