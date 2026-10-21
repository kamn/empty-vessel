// Preloaded for every test file (bunfig.toml): tests talk only to servers on this machine. A request anywhere else
// fails at once instead of reaching a real service (a fake HTTP option misnamed once sent a test's fake token to a
// real login server). Tests that need their own fetch still replace it; child processes aren't covered.
const real = globalThis.fetch
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

const local = (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
  return url.protocol === "file:" || LOCAL.has(url.hostname) || /^127\./.test(url.hostname)
}

globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
  if (!local(input)) return Promise.reject(new Error(`tests don't reach the network: ${String(input instanceof Request ? input.url : input)}`))
  return real(input, init)
}, { preconnect: real.preconnect }) as typeof fetch
