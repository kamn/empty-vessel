// Logging in to a remote MCP server, the standard MCP way, with only fetch and Bun:
// the server's resource metadata names its login server; that one's metadata gives the endpoints; empty-vessel registers
// itself as a client (dynamic registration, no secret), sends the user's browser to log in with PKCE, catches the
// redirect on a local port, and trades the code for tokens. Tokens are refreshed with the refresh token.
// Storing them, and opening the browser, are the caller's job (empty-vessel keeps them in ~/.empty-vessel).

export type Login = {
  readonly resource: string // the MCP server's URL
  readonly clientId: string
  readonly tokenEndpoint: string
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt?: number // ms since epoch
}

type Json = Record<string, any>
const getJson = async (url: string) => { const r = await fetch(url, { headers: { accept: "application/json" } }); return r.ok ? ((await r.json()) as Json) : undefined }
const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

// The login server's endpoints, from the MCP server's URL: its protected-resource metadata (for the path, then the
// root), then the authorization server's metadata (OAuth's, or OpenID's).
export const discover = async (resource: string) => {
  const u = new URL(resource)
  const meta = (await getJson(`${u.origin}/.well-known/oauth-protected-resource${u.pathname}`)) ?? (await getJson(`${u.origin}/.well-known/oauth-protected-resource`))
  const issuer: string | undefined = meta?.authorization_servers?.[0]
  if (!issuer) throw new Error(`${resource} doesn't say where to log in (no protected-resource metadata)`)
  const as = (await getJson(`${issuer}/.well-known/oauth-authorization-server`)) ?? (await getJson(`${issuer}/.well-known/openid-configuration`))
  if (!as?.authorization_endpoint || !as?.token_endpoint) throw new Error(`${issuer} has no login metadata`)
  return { authorize: as.authorization_endpoint as string, token: as.token_endpoint as string, register: as.registration_endpoint as string | undefined }
}

const tokens = async (tokenEndpoint: string, form: Record<string, string>) => {
  const r = await fetch(tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form) })
  const body = (await r.json().catch(() => ({}))) as Json
  if (!r.ok || !body.access_token) throw new Error(`login failed: ${body.error_description ?? body.error ?? `HTTP ${r.status}`}`)
  return body
}

// Log in: `open` sends the user to the login page (a browser); resolves when the login server redirects back.
// `timeoutMs`: how long to wait for the user (default 5 minutes).
export const login = async (resource: string, open: (url: string) => void | Promise<void>, timeoutMs = 300_000): Promise<Login> => {
  const endpoints = await discover(resource)
  if (!endpoints.register) throw new Error("the login server doesn't allow a client to register itself (no registration endpoint)")

  // The redirect lands here: one request, then the server stops.
  let arrived: (params: URLSearchParams) => void = () => {}
  const callback = new Promise<URLSearchParams>((resolve) => { arrived = resolve })
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (req) => {
      const url = new URL(req.url)
      if (url.pathname !== "/callback") return new Response("not found", { status: 404 })
      arrived(url.searchParams)
      return new Response("Logged in: you can close this tab and go back to empty-vessel.", { headers: { "content-type": "text/plain; charset=utf-8" } })
    },
  })

  try {
    const redirect = `http://127.0.0.1:${server.port}/callback`
    const reg = await fetch(endpoints.register, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_name: "empty-vessel", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    })
    const client = (await reg.json().catch(() => ({}))) as Json
    if (!reg.ok || !client.client_id) throw new Error(`couldn't register with the login server: ${client.error_description ?? `HTTP ${reg.status}`}`)

    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
    const state = base64url(crypto.getRandomValues(new Uint8Array(16)))
    const url = new URL(endpoints.authorize)
    for (const [k, v] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state, resource })) url.searchParams.set(k, v)
    await open(url.toString())

    const params = await Promise.race([callback, Bun.sleep(timeoutMs).then(() => { throw new Error("login timed out: no redirect from the browser") })])
    if (params.get("state") !== state) throw new Error("login failed: the redirect's state doesn't match")
    const code = params.get("code")
    if (!code) throw new Error(`login failed: ${params.get("error_description") ?? params.get("error") ?? "no code"}`)

    const t = await tokens(endpoints.token, { grant_type: "authorization_code", code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource })
    return { resource, clientId: client.client_id, tokenEndpoint: endpoints.token, accessToken: t.access_token, ...(t.refresh_token ? { refreshToken: t.refresh_token } : {}), ...(t.expires_in ? { expiresAt: Date.now() + t.expires_in * 1000 } : {}) }
  } finally { server.stop(true) }
}

// A fresh access token from the refresh token (the login server may send a new refresh token too).
export const refresh = async (l: Login): Promise<Login> => {
  if (!l.refreshToken) throw new Error("the login has expired and can't be refreshed: log in again")
  const t = await tokens(l.tokenEndpoint, { grant_type: "refresh_token", refresh_token: l.refreshToken, client_id: l.clientId, resource: l.resource })
  return { ...l, accessToken: t.access_token, refreshToken: t.refresh_token ?? l.refreshToken, ...(t.expires_in ? { expiresAt: Date.now() + t.expires_in * 1000 } : {}) }
}
