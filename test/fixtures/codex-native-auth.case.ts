import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Also preloaded by CLI subprocesses: reject accidental execution before imports can do work.
if (process.env.EMPTY_VESSEL_NATIVE_AUTH_TEST !== "1" || process.env.CODEX_HOME !== join(homedir(), ".codex") || process.env.EMPTY_VESSEL_HOME !== join(homedir(), ".empty-vessel")) {
  throw new Error("Run test/plugins/codex-native-auth.test.ts with its isolated HOME")
}
const forbiddenFetch = Object.assign(() => { throw new Error("Real HTTP is forbidden in native auth tests") }, {
  preconnect: () => { throw new Error("Real HTTP is forbidden in native auth tests") },
})
globalThis.fetch = forbiddenFetch

// CLI preloads only install the guard; bun:test must never be imported outside the test runner.
if (process.env.EMPTY_VESSEL_NATIVE_AUTH_MODE !== "cli") {
  const { expect, test } = await import("bun:test")
  const { Effect } = await import("effect")
  const { HttpClient, HttpClientResponse } = await import("effect/unstable/http")
  const { codexModel, readCodexAuth } = await import("../../src/plugins/codex/codex")
  const nativeFile = join(process.env.EMPTY_VESSEL_HOME!, "providers/codex.json")
  const legacyFile = join(homedir(), ".codex/auth.json")
  const legacyBefore = readFileSync(legacyFile, "utf8")
  const credentials = { access: "native-access-secret", refresh: "native-refresh-secret", expires: Date.now() + 3_600_000, accountId: "native-account" }
  const save = (value: unknown) => writeFileSync(nativeFile, JSON.stringify(value))
  const request = { instructions: "Answer briefly", thread: [], tools: [] }
  const fakeHttp = () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = []
    const client = HttpClient.make((httpRequest) => Effect.sync(() => {
      requests.push({ url: httpRequest.url, headers: { ...httpRequest.headers }, body: JSON.parse(new TextDecoder().decode((httpRequest.body as { body: Uint8Array }).body)) })
      const events = [
        { type: "response.output_text.done", text: "Native authenticated answer" },
        { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 3 } } },
      ]
      return HttpClientResponse.fromWeb(httpRequest, new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }))
    }))
    return { client, requests }
  }
  const rejectedModel = (checkRead = true) => Effect.gen(function* () {
    const { client, requests } = fakeHttp()
    if (checkRead) {
      const auth = yield* Effect.exit(readCodexAuth)
      expect(auth._tag).toBe("Failure")
    }
    const reply = yield* Effect.exit(codexModel(client, "native-auth-test").complete(request))
    expect(reply._tag).toBe("Failure")
    expect(requests).toHaveLength(0)
    expect(readFileSync(legacyFile, "utf8")).toBe(legacyBefore)
  })

  if (process.env.EMPTY_VESSEL_NATIVE_AUTH_MODE === "logged-out") {
    test("CLI logout blocks the real model path despite valid legacy credentials", () => Effect.runPromise(rejectedModel()))
  } else {
    test("real Codex model sends native token and account, parses streamed reply, and leaves legacy untouched", () => Effect.runPromise(Effect.gen(function* () {
      save({ version: 1, credentials })
      const { client, requests } = fakeHttp()
      const reply = yield* codexModel(client, "native-auth-test").complete(request)

      expect(reply.text).toBe("Native authenticated answer")
      expect(requests).toHaveLength(1)
      expect(requests[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses")
      expect(requests[0]!.headers.authorization).toBe(`Bearer ${credentials.access}`)
      expect(requests[0]!.headers["chatgpt-account-id"]).toBe(credentials.accountId)
      expect(requests[0]!.body.model).toBe("native-auth-test")
      expect(requests[0]!.body.stream).toBe(true)
      expect(JSON.stringify(requests)).not.toContain(credentials.refresh)
      expect(readFileSync(legacyFile, "utf8")).toBe(legacyBefore)
      expect(JSON.parse(readFileSync(nativeFile, "utf8"))).toEqual({ version: 1, credentials })
    })))

    test("missing native file uses legacy read-only through the real model path", () => Effect.runPromise(Effect.gen(function* () {
      if (existsSync(nativeFile)) unlinkSync(nativeFile)
      const { client, requests } = fakeHttp()
      const reply = yield* codexModel(client, "legacy-auth-test").complete(request)
      const legacy = JSON.parse(legacyBefore).tokens

      expect(reply.text).toBe("Native authenticated answer")
      expect(requests).toHaveLength(1)
      expect(requests[0]!.headers.authorization).toBe(`Bearer ${legacy.access_token}`)
      expect(requests[0]!.headers["chatgpt-account-id"]).toBe(legacy.account_id)
      expect(existsSync(nativeFile)).toBe(false)
      expect(readFileSync(legacyFile, "utf8")).toBe(legacyBefore)
    })))

    test("malformed native file fails closed rather than using valid legacy credentials", () => {
      writeFileSync(nativeFile, "{broken native JSON")
      return Effect.runPromise(rejectedModel())
    })

    test("native logout marker fails closed rather than using valid legacy credentials", () => {
      save({ version: 1, credentials: null })
      return Effect.runPromise(rejectedModel())
    })

    test("native model refreshes expired credentials, persists rotation, and reuses it on the next request", () => Effect.runPromise(Effect.gen(function* () {
      save({ version: 1, credentials: { ...credentials, expires: 1 } })
      const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: credentials.accountId } })).toString("base64url")
      const access = `e30.${payload}.sig`
      let refreshes = 0
      globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
        if (String(input) !== "https://auth.openai.com/oauth/token") throw new Error("Unexpected HTTP request in native auth test")
        const body = new URLSearchParams(init?.body as string)
        expect(body.get("grant_type")).toBe("refresh_token")
        expect(body.get("refresh_token")).toBe(credentials.refresh)
        refreshes++
        return Promise.resolve(new Response(JSON.stringify({ access_token: access, refresh_token: "native-rotated-secret", expires_in: 3600 }), { status: 200 }))
      }, { preconnect: forbiddenFetch.preconnect }) as typeof fetch

      yield* Effect.gen(function* () {
        const { client, requests } = fakeHttp()
        const model = codexModel(client, "native-auth-test")
        const first = yield* model.complete(request)
        expect(first.text).toBe("Native authenticated answer")
        expect(JSON.parse(readFileSync(nativeFile, "utf8")).credentials.refresh).toBe("native-rotated-secret")
        yield* model.complete(request)
        expect(refreshes).toBe(1)
        expect(requests).toHaveLength(2)
        expect(requests.every((entry) => entry.headers.authorization === `Bearer ${access}`)).toBe(true)
        expect(requests.every((entry) => entry.headers["chatgpt-account-id"] === credentials.accountId)).toBe(true)
        expect(readFileSync(legacyFile, "utf8")).toBe(legacyBefore)
      }).pipe(Effect.ensuring(Effect.sync(() => { globalThis.fetch = forbiddenFetch })))
    })))

    for (const status of [401, 403]) {
      test(`model HTTP ${status} gives safe reconnect instructions without using legacy credentials`, () => Effect.runPromise(Effect.gen(function* () {
        save({ version: 1, credentials })
        let calls = 0
        const client = HttpClient.make((httpRequest) => Effect.sync(() => {
          calls++
          expect(httpRequest.headers.authorization).toBe(`Bearer ${credentials.access}`)
          return HttpClientResponse.fromWeb(httpRequest, new Response("private-provider-error", { status }))
        }))
        const error = yield* Effect.flip(codexModel(client, "native-auth-test").complete(request))
        expect(error).toMatchObject({ _tag: "CodexAuthError" })
        expect(String(error)).toContain("empty-vessel login codex")
        expect(String(error)).not.toContain("private-provider-error")
        expect(calls).toBe(1)
        expect(readFileSync(legacyFile, "utf8")).toBe(legacyBefore)
      })))
    }

    test("rejected native refresh never falls back or reaches the model transport", () => Effect.runPromise(Effect.gen(function* () {
      save({ version: 1, credentials: { ...credentials, expires: 1 } })
      const refreshRequests: string[] = []
      globalThis.fetch = Object.assign((input: string | URL | Request) => {
        refreshRequests.push(String(input))
        return Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }))
      }, { preconnect: forbiddenFetch.preconnect }) as typeof fetch

      yield* rejectedModel(false).pipe(Effect.ensuring(Effect.sync(() => { globalThis.fetch = forbiddenFetch })))
      expect(refreshRequests.length).toBeGreaterThan(0)
      expect(refreshRequests.every((url) => url === "https://auth.openai.com/oauth/token")).toBe(true)
    })))
  }
}
