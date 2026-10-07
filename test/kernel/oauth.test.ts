import { expect, test } from "bun:test"
import { login, refresh } from "../../src/kernel/oauth"

// A fake MCP server and login server in one: resource metadata, login metadata, registration, an authorize page that
// redirects straight back (the "browser" follows it), and a token endpoint that checks PKCE.
const fakeLogin = () => {
  const codes = new Map<string, { challenge: string; client: string }>()
  const server = Bun.serve({
    port: 0,
    fetch: async (req): Promise<Response> => {
      const url = new URL(req.url), base = url.origin
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] })
      if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` })
      if (url.pathname === "/register") return Response.json({ client_id: "client-1", ...(await req.json() as object) }, { status: 201 })
      if (url.pathname === "/authorize") {
        codes.set("code-1", { challenge: url.searchParams.get("code_challenge")!, client: url.searchParams.get("client_id")! })
        return Response.redirect(`${url.searchParams.get("redirect_uri")}?code=code-1&state=${url.searchParams.get("state")}`, 302)
      }
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await req.text())
        if (form.get("grant_type") === "refresh_token") return Response.json({ access_token: "access-2", expires_in: 3600 })
        const c = codes.get(form.get("code")!)
        const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier")!))).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
        if (!c || c.challenge !== digest || c.client !== form.get("client_id")) return Response.json({ error: "invalid_grant" }, { status: 400 })
        return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { server, resource: `http://localhost:${server.port}/mcp` }
}

test("login: discovery, registration, PKCE, the browser's redirect caught on a local port, the code traded for tokens; then refresh", async () => {
  const { server, resource } = fakeLogin()
  try {
    const browser = async (url: string) => { await fetch(url) } // follows the redirect back to the local port, as a browser would
    const l = await login(resource, browser)
    expect(l).toMatchObject({ resource, clientId: "client-1", accessToken: "access-1", refreshToken: "refresh-1" })
    expect(l.expiresAt).toBeGreaterThan(Date.now())

    const r = await refresh(l)
    expect(r).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-1" }) // no new refresh token: the old one stays
  } finally { server.stop(true) }
})

test("login fails clearly when the server doesn't say where to log in", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("not found", { status: 404 }) })
  try {
    await expect(login(`http://localhost:${server.port}/mcp`, () => {})).rejects.toThrow("doesn't say where to log in")
  } finally { server.stop(true) }
})
