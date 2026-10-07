import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { Effect, Fiber } from "effect"
import { CodexAuthError, type CodexCredentials } from "../../src/plugins/codex/auth-store"
import { makeCodexOAuth, type CodexOAuthOptions } from "../../src/plugins/codex/oauth"

const secret = "private-provider-secret"
const jwt = (id: unknown = "account-1") => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.sig`
const payload = () => ({ access_token: jwt(), refresh_token: secret, expires_in: 3600 })
const old: CodexCredentials = { access: jwt(), refresh: "old-refresh", expires: 1, accountId: "account-1" }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const run = Effect.runPromise
const failure = <A>(effect: Effect.Effect<A, CodexAuthError>) => run(Effect.flip(effect))
const respond = (url: string) => Effect.tryPromise({ try: () => fetch(url), catch: () => new CodexAuthError({ message: "Local callback failed" }) }).pipe(Effect.asVoid)
const callbackUrl = (authorization: string, params: Record<string, string>) => {
  const url = new URL(new URL(authorization).searchParams.get("redirect_uri")!)
  url.hostname = "127.0.0.1"
  url.search = new URLSearchParams(params).toString()
  return url.toString()
}
const available = (port: number) => run(Effect.callback<void, Error>((resume) => {
  const server = createServer()
  server.once("error", (error) => resume(Effect.fail(error)))
  server.listen(port, "127.0.0.1", () => server.close(() => resume(Effect.void)))
}))

test("browser listener is active before callback; PKCE and exchange match; cleanup", () => {
  let authorization = ""
  let port = 0
  const oauth = makeCodexOAuth({ port: 0, now: () => 1000, fetch: (_url, init) => {
    const auth = new URL(authorization).searchParams
    const body = new URLSearchParams(init.body as string)
    expect(auth.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann")
    expect(auth.get("code_challenge_method")).toBe("S256")
    expect(auth.get("scope")).toBe("openid profile email offline_access")
    expect(auth.get("state")!.length).toBeGreaterThan(30)
    expect(auth.get("code_challenge")).toBe(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"))
    expect(body.get("code")).toBe("test-code")
    expect(body.get("redirect_uri")).toBe(auth.get("redirect_uri"))
    return Promise.resolve(json(payload()))
  } })
  return run(oauth.loginCodexBrowser((url) => {
    authorization = url
    port = Number(new URL(new URL(url).searchParams.get("redirect_uri")!).port)
    return respond(callbackUrl(url, { state: new URL(url).searchParams.get("state")!, code: "test-code" }))
  })).then((credentials) => {
    expect(credentials).toEqual({ access: jwt(), refresh: secret, expires: 3601000, accountId: "account-1" })
    return available(port)
  })
})

for (const kind of ["error", "missing"] as const) {
  test(`browser rejects ${kind} without exchanging or leaking callback details`, () => {
    let port = 0
    const oauth = makeCodexOAuth({ port: 0, fetch: () => { throw new Error("must not exchange") } })
    return failure(oauth.loginCodexBrowser((url) => {
      port = Number(new URL(new URL(url).searchParams.get("redirect_uri")!).port)
      const params: Record<string, string> = { state: new URL(url).searchParams.get("state")! }
      if (kind === "error") { params.error = secret; params.error_description = secret }
      return respond(callbackUrl(url, params))
    })).then((error) => {
      expect(error.message).not.toContain(secret)
      expect(error.message).toMatch(kind === "error" ? /denied/ : /Missing/)
      return available(port)
    })
  })
}

test("browser timeout cleans listener even while notification never completes", () => {
  let port = 0
  return failure(makeCodexOAuth({ port: 0, loginTimeoutMs: 40 }).loginCodexBrowser((url) => {
    port = Number(new URL(new URL(url).searchParams.get("redirect_uri")!).port)
    return Effect.never
  })).then((error) => { expect(error.message).toContain("timed out"); return available(port) })
})

test("browser interruption cleans listener", () => run(Effect.gen(function* () {
  let port = 0
  const fiber = yield* Effect.forkChild(makeCodexOAuth({ port: 0 }).loginCodexBrowser((url) => Effect.sync(() => {
    port = Number(new URL(new URL(url).searchParams.get("redirect_uri")!).port)
  })))
  while (!port) yield* Effect.sleep(1)
  yield* Fiber.interrupt(fiber)
  yield* Effect.promise(() => available(port))
})))

test("refresh preserves omitted refresh token, rotates provided refresh token", () => run(Effect.gen(function* () {
  for (const refresh of [undefined, "rotated"]) {
    const value: Record<string, unknown> = payload()
    if (refresh === undefined) delete value.refresh_token
    else value.refresh_token = refresh
    const credentials = yield* makeCodexOAuth({ fetch: (_url, init) => {
      expect(new URLSearchParams(init.body as string).get("grant_type")).toBe("refresh_token")
      return Promise.resolve(json(value))
    } }).refreshCodexCredentials(old)
    expect(credentials.refresh).toBe(refresh ?? old.refresh)
  }
})))

for (const invalid of ["", " ", null, 3]) {
  test(`refresh rejects explicit invalid refresh token ${JSON.stringify(invalid)}`, () => failure(makeCodexOAuth({ fetch: () => Promise.resolve(json({ ...payload(), refresh_token: invalid })) }).refreshCodexCredentials(old)).then((e) => expect(e.message).toContain("Invalid")))
}

for (const [index, value] of [null, {}, { ...payload(), expires_in: -1 }, { ...payload(), expires_in: "3600" }, { ...payload(), expires_in: 1e308 }, { ...payload(), access_token: secret }, { ...payload(), access_token: jwt(4) }, { ...payload(), access_token: jwt("") }].entries()) {
  test(`invalid token metadata is rejected (case ${index})`, () => failure(makeCodexOAuth({ fetch: () => Promise.resolve(json(value)) }).refreshCodexCredentials(old)).then((e) => expect(e.message).not.toContain(secret)))
}

for (const mode of ["status", "network", "json"] as const) {
  test(`refresh ${mode} errors are sanitized`, () => {
    const http: NonNullable<CodexOAuthOptions["fetch"]> = () => mode === "network" ? Promise.reject(new Error(secret)) : Promise.resolve(mode === "status" ? json({ error: secret }, 401) : new Response(secret))
    return failure(makeCodexOAuth({ fetch: http }).refreshCodexCredentials(old)).then((e) => expect(e.message).not.toContain(secret))
  })
}

test("request timeout aborts HTTP", () => {
  let signal: AbortSignal | undefined
  return failure(makeCodexOAuth({ requestTimeoutMs: 20, fetch: (_url, init) => {
    signal = init.signal!
    return new Promise(() => {})
  } }).refreshCodexCredentials(old)).then((e) => { expect(e.message).toContain("timed out"); expect(signal?.aborted).toBe(true) })
})

test("device 403/404 pending then success; server interval honored; exchange parameters", () => {
  let poll = 0
  const sleeps: number[] = []
  let shown = false
  const oauth = makeCodexOAuth({ sleep: (ms) => Effect.sync(() => { sleeps.push(ms) }), fetch: (url, init) => {
    if (url.endsWith("/usercode")) return Promise.resolve(json({ device_auth_id: "device", user_code: "USER", interval: "30" }))
    if (url.endsWith("/deviceauth/token")) {
      expect(shown).toBe(true)
      expect(JSON.parse(init.body as string)).toEqual({ device_auth_id: "device", user_code: "USER" })
      return Promise.resolve(++poll < 3 ? json({}, poll === 1 ? 403 : 404) : json({ authorization_code: "code", code_verifier: "verifier" }))
    }
    const params = new URLSearchParams(init.body as string)
    expect(params.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback")
    expect(params.get("code_verifier")).toBe("verifier")
    return Promise.resolve(json(payload()))
  } })
  return run(oauth.loginCodexDevice((info) => Effect.sync(() => {
    expect(info).toEqual({ url: "https://auth.openai.com/codex/device", code: "USER" }); shown = true
  }))).then((c) => { expect(c.accountId).toBe("account-1"); expect(sleeps).toEqual([30000, 30000, 30000]) })
})

for (const mode of ["initial", "invalid", "poll", "poll-invalid", "exchange"] as const) {
  test(`device ${mode} failure is sanitized`, () => failure(makeCodexOAuth({ sleep: () => Effect.void, fetch: (url) => {
    if (url.endsWith("/usercode")) return Promise.resolve(mode === "initial" ? json(secret, 400) : mode === "invalid" ? json({ interval: "NaN" }) : json({ device_auth_id: "d", user_code: "c", interval: 0 }))
    if (url.endsWith("/deviceauth/token")) return Promise.resolve(mode === "poll" ? json(secret, 500) : mode === "poll-invalid" ? json({ authorization_code: secret }) : json({ authorization_code: "c", code_verifier: "v" }))
    return Promise.resolve(json(secret, 401))
  } }).loginCodexDevice(() => Effect.void)).then((e) => expect(e.message).not.toContain(secret)))
}

test("device expiry uses injected clock and enforces minimum interval", () => {
  let time = 0
  let polls = 0
  return failure(makeCodexOAuth({ now: () => time, sleep: (ms) => Effect.sync(() => { expect(ms).toBe(1000); time += ms }), fetch: (url) => {
    if (url.endsWith("/usercode")) return Promise.resolve(json({ device_auth_id: "d", user_code: "c", interval: 0, expires_in: 2 }))
    polls++
    return Promise.resolve(json({}, 403))
  } }).loginCodexDevice(() => Effect.void)).then((e) => { expect(e.message).toContain("expired"); expect(polls).toBe(1) })
})

test("device full timeout includes notification", () => {
  const oauth = makeCodexOAuth({ loginTimeoutMs: 20, fetch: () => Promise.resolve(json({ device_auth_id: "d", user_code: "c", interval: 1 })) })
  return failure(oauth.loginCodexDevice(() => Effect.never)).then((e) => expect(e.message).toContain("timed out"))
})

test("browser notification failure releases port", () => {
  let port = 0
  return failure(makeCodexOAuth({ port: 0 }).loginCodexBrowser((url) => {
    port = Number(new URL(new URL(url).searchParams.get("redirect_uri")!).port)
    return Effect.fail(new CodexAuthError({ message: "Notification failed" }))
  })).then(() => available(port))
})

test("browser bind conflict fails safely without announcing URL", () => run(Effect.scoped(Effect.gen(function* () {
  const server = yield* Effect.acquireRelease(Effect.sync(() => createServer()), (s) => Effect.callback<void>((resume) => { s.close(() => resume(Effect.void)) }))
  yield* Effect.callback<void>((resume) => { server.listen(0, "127.0.0.1", () => resume(Effect.void)) })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing test address")
  let announced = false
  const error = yield* Effect.flip(makeCodexOAuth({ port: address.port }).loginCodexBrowser(() => Effect.sync(() => { announced = true })))
  expect(error.message).toContain("loopback")
  expect(announced).toBe(false)
}))))

test("browser exchange rejection does not leak tokens and releases listener", () => {
  let port = 0
  return failure(makeCodexOAuth({ port: 0, fetch: () => Promise.resolve(json({ error: secret }, 401)) }).loginCodexBrowser((url) => {
    port = Number(new URL(new URL(url).searchParams.get("redirect_uri")!).port)
    return respond(callbackUrl(url, { code: secret, state: new URL(url).searchParams.get("state")! }))
  })).then((error) => { expect(error.message).not.toContain(secret); return available(port) })
})

test("timeout during body consumption aborts request", () => {
  let signal: AbortSignal | undefined
  return failure(makeCodexOAuth({ requestTimeoutMs: 20, fetch: (_url, init) => {
    signal = init.signal!
    return Promise.resolve({ ok: true, json: () => new Promise(() => {}) } as Response)
  } }).refreshCodexCredentials(old)).then((error) => { expect(error.message).toContain("timed out"); expect(signal?.aborted).toBe(true) })
})

test("device interruption aborts in-flight polling request", () => run(Effect.gen(function* () {
  let signal: AbortSignal | undefined
  const oauth = makeCodexOAuth({ sleep: () => Effect.void, fetch: (url, init) => {
    if (url.endsWith("/usercode")) return Promise.resolve(json({ device_auth_id: "d", user_code: "c", interval: 1 }))
    signal = init.signal!
    return new Promise(() => {})
  } })
  const fiber = yield* Effect.forkChild(oauth.loginCodexDevice(() => Effect.void))
  while (!signal) yield* Effect.sleep(1)
  yield* Fiber.interrupt(fiber)
  expect(signal.aborted).toBe(true)
})))

test("unrelated callbacks cannot cancel the browser login attempt", () => {
  let exchanges = 0
  let port = 0
  const oauth = makeCodexOAuth({ port: 0, loginTimeoutMs: 2000, fetch: () => {
    exchanges++
    return Promise.resolve(json(payload()))
  } })
  return run(oauth.loginCodexBrowser((authorization) => Effect.tryPromise({
    try: async () => {
      const state = new URL(authorization).searchParams.get("state")!
      port = Number(new URL(new URL(authorization).searchParams.get("redirect_uri")!).port)
      const invalid = [
        callbackUrl(authorization, { code: secret }),
        callbackUrl(authorization, { state: "wrong", code: secret }),
        callbackUrl(authorization, { state: "wrong", error: secret }),
        callbackUrl(authorization, { state, code: secret }) + "&state=duplicate",
      ]
      for (const url of invalid) {
        const response = await fetch(url)
        expect(response.status).toBe(400)
        expect(await response.text()).not.toContain(secret)
      }
      const url = callbackUrl(authorization, { state, code: "valid-code" })
      expect((await fetch(url, { method: "POST" })).status).toBe(400)
      expect(exchanges).toBe(0)
      expect((await fetch(url)).status).toBe(200)
    },
    catch: () => new CodexAuthError({ message: "Local callback regression failed" }),
  }))).then((value) => {
    expect(value.accountId).toBe("account-1")
    expect(exchanges).toBe(1)
    return available(port)
  })
})

test("device polling respects issuer intervals longer than thirty seconds", () => {
  const waits: number[] = []
  let requests = 0
  let clock = 1000
  const oauth = makeCodexOAuth({
    now: () => clock,
    sleep: (ms) => Effect.sync(() => { waits.push(ms); clock += ms }),
    fetch: () => {
      requests++
      if (requests === 1) return Promise.resolve(json({ device_auth_id: "fake-device", user_code: "fake-code", interval: "60" }))
      if (requests === 2) return Promise.resolve(json({ authorization_code: "fake-authorization", code_verifier: "fake-verifier" }))
      return Promise.resolve(json(payload()))
    },
  })
  return run(oauth.loginCodexDevice(() => Effect.void)).then(() => {
    expect(waits).toEqual([60_000])
    expect(requests).toBe(3)
  })
})
