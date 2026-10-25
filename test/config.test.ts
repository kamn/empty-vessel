import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { configCheck, configGet, configSet, configShow, configUnset, type ConfigIo } from "../src/config"

const KEYED = { systemTwo: { use: "or" }, plugins: { or: { from: "openai", config: { baseUrl: "http://localhost:1/v1", model: "m", apiKey: "sk-secret" } }, x: { config: { password: "hunter2" } } } }

// A config file (or none), an io that records what's said and answers hidden questions from a queue.
const home = (before?: object | string, secrets: ReadonlyArray<string> = []) => {
  const file = join(mkdtempSync(join(tmpdir(), "empty-vessel-config-")), "config.json")
  if (before !== undefined) writeFileSync(file, typeof before === "string" ? before : JSON.stringify(before))
  const said: Array<string> = [], asked: Array<string> = [], queue = [...secrets]
  const io: ConfigIo = { ask: () => "", secret: (q: string) => { asked.push(q); return queue.shift() ?? "" }, say: (l: string) => Effect.sync(() => { said.push(l) }) }
  const run = <A>(effect: (file: string, io: ConfigIo) => Effect.Effect<A>) => Effect.runPromise(effect(file, io))
  return { file, io, run, said, asked, text: () => said.join("\n"), config: () => JSON.parse(readFileSync(file, "utf8")) }
}

test("set makes the objects on the way; get reads by dotted path; unset removes", async () => {
  const h = home({ theme: "teal" })

  expect(await h.run((f, io) => configSet(f, "systemTwo.reasoning", "high", false, io))).toBe(true)
  expect(await h.run((f, io) => configSet(f, "plugins.codex.config.model", "gpt-x", false, io))).toBe(true)
  expect(h.config()).toEqual({ theme: "teal", systemTwo: { reasoning: "high" }, plugins: { codex: { config: { model: "gpt-x" } } } })
  expect(statSync(h.file).mode & 0o777).toBe(0o600)

  await h.run((f, io) => configGet(f, "plugins.codex.config.model", false, io))
  await h.run((f, io) => configGet(f, "plugins.codex", false, io))
  expect(h.said.slice(-2)).toEqual(["gpt-x", JSON.stringify({ config: { model: "gpt-x" } }, null, 2)])

  expect(await h.run((f, io) => configUnset(f, "systemTwo.reasoning", io))).toBe(true)
  expect(h.config().systemTwo).toEqual({})
  await h.run((f, io) => configUnset(f, "systemTwo.reasoning", io))
  expect(h.said.at(-1)).toBe("systemTwo.reasoning isn't set: nothing changed.")
  expect(await h.run((f, io) => configGet(f, "systemTwo.reasoning", false, io))).toBe(false)
})

test("a value is JSON when it parses, else text; nothing is set through a non-object", async () => {
  const h = home({})
  for (const [key, value] of [["a.t", "true"], ["a.n", "5"], ["a.z", "null"], ["a.l", `["a"]`], ["a.o", `{"x":1}`], ["a.s", "hello world"]] as const) await h.run((f, io) => configSet(f, key, value, true, io))
  expect(h.config()).toEqual({ a: { t: true, n: 5, z: null, l: ["a"], o: { x: 1 }, s: "hello world" } })

  expect(await h.run((f, io) => configSet(f, "a.l.x", "1", true, io))).toBe(false)
  expect(h.said.at(-1)).toContain("a.l is [\"a\"], not an object")
})

test("with no value it's asked unseen, and never echoed or printed", async () => {
  const h = home(KEYED, ["sk-typed"])
  expect(await h.run((f, io) => configSet(f, "plugins.or.config.apiKey", undefined, false, io))).toBe(true)
  expect(h.asked).toHaveLength(1)
  expect(h.config().plugins.or.config.apiKey).toBe("sk-typed")
  expect(h.text()).not.toContain("sk-typed")

  // Enter (nothing typed): nothing changed.
  expect(await h.run((f, io) => configSet(f, "plugins.or.config.apiKey", undefined, false, io))).toBe(false)
  expect(h.config().plugins.or.config.apiKey).toBe("sk-typed")
})

test("a key this version doesn't know is saved with a notice, which --force hides; a copy's settings are its plugin's", async () => {
  const h = home(KEYED)

  await h.run((f, io) => configSet(f, "systemTwo.reasonng", "high", false, io))
  expect(h.said.at(-1)).toContain("saved, but systemTwo.reasonng isn't a setting this version knows")
  await h.run((f, io) => configSet(f, "other", "1", true, io))
  expect(h.said.at(-1)).not.toContain("isn't a setting")
  expect(h.config()).toMatchObject({ systemTwo: { reasonng: "high" }, other: 1 })

  for (const key of ["plugins.or.config.fillModel", "plugins.codex.config.model", "sources.gh.headers.authorization", "systemTwo.use"]) {
    await h.run((f, io) => configSet(f, key, key === "systemTwo.use" ? "codex" : "v", false, io))
    expect(h.said.at(-1)).not.toContain("isn't a setting")
  }
})

test("a value that's wrong for its setting, or would stop the config loading, is refused and the file left as it was", async () => {
  const h = home(KEYED)
  const before = readFileSync(h.file, "utf8")

  for (const [key, value, why] of [
    ["systemTwo.use", "nope", `no plugin provides a systemTwo by that name`],
    ["maxSteps", "many", "Expected number"],
    ["theme", "pink", `"orange" | "blue" | "green" | "teal"`],
    ["plugins.telegram.config.allowedUserId", "abc", "plugins.telegram.config.allowedUserId"],
    ["plugins.or.config.model", "5", "plugins.or.config.model"],
  ] as const) {
    expect(await h.run((f, io) => configSet(f, key, value, true, io))).toBe(false)
    expect(h.said.at(-1)).toContain(why)
  }

  expect(readFileSync(h.file, "utf8")).toBe(before)
})

test("show redacts every secret; get does too unless --reveal", async () => {
  const h = home({ ...KEYED, sources: { gh: { headers: { authorization: "Bearer tok" } } } })

  await h.run(configShow)
  expect(h.text()).toContain(`"apiKey": "<redacted>"`)
  expect(h.text()).toContain(`"password": "<redacted>"`)
  expect(h.text()).toContain(`"model": "m"`)
  for (const secret of ["sk-secret", "hunter2", "Bearer tok"]) expect(h.text()).not.toContain(secret)

  await h.run((f, io) => configGet(f, "plugins.or.config.apiKey", false, io))
  expect(h.said.at(-1)).toBe("<redacted>")
  await h.run((f, io) => configGet(f, "plugins.or", false, io))
  expect(h.said.at(-1)).not.toContain("sk-secret")
  await h.run((f, io) => configGet(f, "plugins.or.config.apiKey", true, io))
  expect(h.said.at(-1)).toBe("sk-secret")
})

test("check passes a good config and fails a broken one, saying why", async () => {
  expect(await home(KEYED).run(configCheck)).toBe(true)

  const broken = home("{ broken")
  expect(await broken.run(configCheck)).toBe(false)
  expect(broken.text()).toContain("isn't a JSON object")
  expect(await broken.run((f, io) => configSet(f, "theme", "blue", false, io))).toBe(false)
  expect(readFileSync(broken.file, "utf8")).toBe("{ broken")

  const wrong = home({ systemTwo: { use: "or" }, plugins: { or: { from: "openai", config: {} } } })
  expect(await wrong.run(configCheck)).toBe(false)
  expect(wrong.text()).toContain("plugins.or.config")
})

test("config path (and the rest, from the command line) use EMPTY_VESSEL_HOME's config.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-config-"))
  writeFileSync(join(dir, "config.json"), JSON.stringify(KEYED))
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("EMPTY_VESSEL_"))), EMPTY_VESSEL_HOME: dir }
  const cli = (...args: Array<string>) => Bun.spawnSync(["bun", join(import.meta.dir, "../src/main.ts"), "config", ...args], { env })

  expect(cli("path").stdout.toString().trim()).toBe(join(dir, "config.json"))
  expect(cli("get", "plugins.or.config.apiKey").stdout.toString().trim()).toBe("<redacted>")
  expect(cli("get", "nope").exitCode).toBe(1)
})
