import { expect, test } from "bun:test"

test("tests can't reach the network: a request to a real host fails at once; localhost still works", async () => {
  await expect(fetch("https://auth.openai.com/oauth/token", { method: "POST" })).rejects.toThrow("tests don't reach the network")
  const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
  try { expect(await (await fetch(`http://localhost:${server.port}/`)).text()).toBe("ok") } finally { server.stop(true) }
})
