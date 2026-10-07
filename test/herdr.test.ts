import { expect, test } from "bun:test"
import { resolve } from "node:path"

// A fresh process per case: the integration reads its environment when imported.
// Capture commands instead of sending reports to the user's real Herdr pane.
const run = (env: Record<string, string>, action: string, throws = false) => {
  const code = `
    import { Effect } from "effect";
    const calls = [];
    Bun.spawn = (args) => { calls.push(args); ${throws ? 'throw new Error("missing binary")' : 'return {}'} };
    const { reportState, releaseAgent } = await import(${JSON.stringify(resolve("src/integrations/herdr.ts"))});
    await Effect.runPromise(Effect.gen(function* () { ${action} }));
    console.log(JSON.stringify(calls));
  `
  const result = Bun.spawnSync([process.execPath, "-e", code], {
    cwd: process.cwd(),
    env: { ...process.env, HERDR_ENV: "", HERDR_BIN_PATH: "", HERDR_PANE_ID: "", ...env },
  })

  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString()) as string[][]
}
const inside = { HERDR_ENV: "1", HERDR_BIN_PATH: "/fake/herdr", HERDR_PANE_ID: "pane-test" }

test("reports session, working, idle and release with increasing sequence numbers", () => {
  const calls = run(inside, `yield* reportState("idle", ["--agent-session-id", "session-test"]); yield* reportState("working"); yield* reportState("idle"); yield* releaseAgent;`)
  const common = ["/fake/herdr", "pane", "report-agent", "pane-test", "--source", "custom:empty-vessel", "--agent", "empty-vessel", "--seq"]

  expect(calls).toHaveLength(4)
  expect(calls[0]!.slice(0, 9)).toEqual(common)
  expect(calls[0]!.slice(10)).toEqual(["--state", "idle", "--agent-session-id", "session-test"])
  expect(calls[1]!.slice(10)).toEqual(["--state", "working"])
  expect(calls[2]!.slice(10)).toEqual(["--state", "idle"])
  expect(calls[3]!.slice(0, 9)).toEqual(common.map((s) => s === "report-agent" ? "release-agent" : s))
  expect(calls[3]).toHaveLength(10)
  const seq = calls.map((c) => Number(c[9]))
  expect(seq.every((n, i) => Number.isFinite(n) && (i === 0 || n > seq[i - 1]!))).toBe(true)
})

test("no reports outside Herdr or with incomplete environment", () => {
  for (const env of [{}, { ...inside, HERDR_ENV: "0" }, { ...inside, HERDR_BIN_PATH: "" }, { ...inside, HERDR_PANE_ID: "" }]) {
    expect(run(env, 'yield* reportState("working"); yield* releaseAgent;')).toEqual([])
  }
})

test("a missing Herdr binary does not fail the caller", () => {
  expect(run(inside, 'yield* reportState("working"); yield* releaseAgent;', true)).toHaveLength(2)
})

test("answer reports idle after success, failure, and interruption, preserving job cleanup", () => {
  for (const outcome of ["Effect.succeed('reply')", "Effect.fail('failure')", "Effect.interrupt"]) {
    const calls = run(inside, `
      const { mock } = yield* Effect.promise(() => import("bun:test"));
      mock.module(${JSON.stringify(resolve("src/loop/turn.ts"))}, () => ({ turn: () => ${outcome} }));
      const { answer } = yield* Effect.promise(() => import(${JSON.stringify(resolve("src/answer.ts"))}));
      const { Usage } = yield* Effect.promise(() => import(${JSON.stringify(resolve("src/base/usage.ts"))}));
      let cleaned = false;
      const conversation = { jobs: { cancelAll: Effect.sync(() => { cleaned = true }) } };
      yield* Effect.exit(answer({}, "test", conversation).pipe(Effect.provide(Usage.layer)));
      if (!cleaned) throw new Error("jobs not cleaned up");
    `)

    expect(calls.map((c) => c.slice(10))).toEqual([["--state", "working"], ["--state", "idle"]])
  }
})
