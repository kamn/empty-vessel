import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigSchema } from "../../src/base/config"
import { described, explain, section, setting, undescribed } from "../../src/base/setting"
import { PLUGINS } from "../../src/plugins/index"

// Every setting says what it is: the types require it (described() only takes setting()s), and this checks it too.
test("every setting in config.json is described: the core's own, in every group, and every bundled plugin's", () => {
  expect(undescribed(ConfigSchema.fields)).toEqual([])
  for (const p of PLUGINS) if (p.settings) expect([p.name, undescribed(p.settings.fields)]).toEqual([p.name, []])
})

test("undescribed names what isn't, by path; a group's and a record's settings are checked inside", () => {
  const fields = {
    a: setting(Schema.String, "described"),
    b: Schema.String,
    group: section({ c: setting(Schema.Int, "described", { default: 1 }), d: Schema.Boolean as never }, "a group"),
    each: setting(Schema.Record(Schema.String, described({ e: Schema.String as never })), "a record of groups", { default: {} }),
  }
  expect(undescribed(fields)).toEqual(["b", "group.d", "each.*.e"])
})

// Defaults are explicit, and decode as before (withDecodingDefaultKey): an empty config is all defaults, unchanged.
test("an empty config decodes to the same defaults as before settings were described", () => {
  expect(Schema.decodeUnknownSync(ConfigSchema)({})).toEqual({
    maxSteps: 20, compactAt: 150_000, testOptions: false, learnAfterTurn: false, ui: "plain", theme: "teal", sources: {},
    adoption: { offerSystemOne: 5, offerSystemTwo: 5, sampler: "thompson", reward: "ok", promoteTo: "pool", askAtEndOfTurn: "never", maxProposals: 1, graduateAfter: 3, dropAfter: 100, dropBelowRate: 0.2, proposals: "eager" },
    maxDepth: 2, systemOne: { use: "fake" }, systemTwo: { use: "fake", reasoning: "medium", maxRounds: 30, webSearch: true, progressMinutes: 5, scopeCheck: true, style: "i-have-adhd" },
    store: { use: "disk" }, memory: { use: "notes", projectChars: 2200, agentChars: 2400 },
    channel: { use: "terminal" },
    kernel: { tools: { files: "read-write", shell: true, systemOne: true, agents: true, library: true, sources: true } },
    plugins: {},
  })
  expect(() => Schema.decodeUnknownSync(ConfigSchema)({ ui: "fancy" })).toThrow() // the allowed values are still enforced
})

test("explain: a setting in words, with its default and allowed values", () => {
  expect(explain(ConfigSchema.fields, "ui")).toBe(`ui: The interactive screen: plain lines, or tui (a live input box, the current step and a status line); -p and piped input are always plain (default "plain"; one of plain, tui)`)
  expect(explain(ConfigSchema.fields, "maxDepth")).toContain("(default 2)")
  expect(explain(ConfigSchema.fields, "nope")).toBeUndefined()
})
