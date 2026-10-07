import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodexAuthError, type CodexCredentials } from "../../src/plugins/codex/auth-store"
import { makeCodexAuthCommands } from "../../src/plugins/codex/commands"

const credentials: CodexCredentials = { access: "private-access", refresh: "private-refresh", expires: 2_000_000_000_000, accountId: "private-account" }
const fixture = (source: "native" | "legacy" | "none" = "none", failure?: "login" | "save") => {
  const messages: string[] = []
  const opened: string[] = []
  const saved: CodexCredentials[] = []
  let browserCalls = 0
  let deviceCalls = 0
  let logoutCalls = 0
  const loginResult = failure === "login"
    ? Effect.fail(new CodexAuthError({ message: "Authorization was denied." }))
    : Effect.succeed(credentials)
  const commands = makeCodexAuthCommands({
    store: {
      status: Effect.succeed({ source, ...(source === "none" ? {} : { expires: credentials.expires }) }),
      save: (value) => failure === "save"
        ? Effect.fail(new CodexAuthError({ message: "Credential storage is unavailable." }))
        : Effect.sync(() => { saved.push(value) }),
      logout: Effect.sync(() => { logoutCalls++ }),
    },
    browser: (onUrl) => Effect.gen(function* () {
      browserCalls++
      yield* onUrl("https://example.test/authorize?state=fake")
      return yield* loginResult
    }),
    device: (onCode) => Effect.gen(function* () {
      deviceCalls++
      yield* onCode({ url: "https://example.test/device", code: "ABCD-TEST" })
      return yield* loginResult
    }),
    print: (message) => Effect.sync(() => { messages.push(message) }),
    open: (url) => Effect.sync(() => { opened.push(url) }),
    file: "/fake/providers/codex.json",
  })
  return { commands, messages, opened, saved, calls: () => ({ browserCalls, deviceCalls, logoutCalls }) }
}

const noCredentialOutput = (messages: string[]) => {
  for (const secret of [credentials.access, credentials.refresh, credentials.accountId]) {
    expect(messages.join("\n")).not.toContain(secret)
  }
}

describe("Codex auth commands", () => {
  test("browser login prints URL, launches browser, then saves independent credentials", async () => {
    const f = fixture()
    await Effect.runPromise(f.commands.login())
    expect(f.opened).toEqual(["https://example.test/authorize?state=fake"])
    expect(f.saved).toEqual([credentials])
    expect(f.calls()).toEqual({ browserCalls: 1, deviceCalls: 0, logoutCalls: 0 })
    expect(f.messages.at(-1)).toContain("Codex CLI credentials were not changed")
    noCredentialOutput(f.messages)
  })

  test("device login prints short code without launching a local browser", async () => {
    const f = fixture()
    await Effect.runPromise(f.commands.login({ deviceCode: true }))
    expect(f.opened).toEqual([])
    expect(f.saved).toEqual([credentials])
    expect(f.calls().deviceCalls).toBe(1)
    expect(f.messages[0]).toContain("ABCD-TEST")
    noCredentialOutput(f.messages)
  })

  for (const source of ["native", "legacy", "none"] as const) {
    test(`status reports ${source} without login or writes`, async () => {
      const f = fixture(source)
      await Effect.runPromise(f.commands.login({ status: true }))
      expect(f.calls()).toEqual({ browserCalls: 0, deviceCalls: 0, logoutCalls: 0 })
      expect(f.saved).toEqual([])
      expect(f.messages.join(" ")).toContain(source === "native" ? "independent" : source === "legacy" ? "read-only" : "not logged in")
      noCredentialOutput(f.messages)
    })
  }

  test("incompatible flags fail before starting authorization", async () => {
    const f = fixture()
    await expect(Effect.runPromise(f.commands.login({ status: true, deviceCode: true }))).rejects.toThrow("Choose either")
    expect(f.calls().browserCalls + f.calls().deviceCalls).toBe(0)
    expect(f.saved).toEqual([])
  })

  for (const failure of ["login", "save"] as const) {
    test(`${failure} failure does not claim successful login`, async () => {
      const f = fixture("none", failure)
      await expect(Effect.runPromise(f.commands.login())).rejects.toThrow()
      expect(f.saved).toEqual([])
      expect(f.messages.join(" ")).not.toContain("login saved")
      noCredentialOutput(f.messages)
    })
  }

  test("logout uses the store and explicitly explains fallback is disabled", async () => {
    const f = fixture("native")
    await Effect.runPromise(f.commands.logout)
    expect(f.calls().logoutCalls).toBe(1)
    expect(f.calls().browserCalls).toBe(0)
    expect(f.messages.join(" ")).toContain("automatic fallback is disabled")
    noCredentialOutput(f.messages)
  })
})
