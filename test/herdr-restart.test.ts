import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const integration = resolve("src/integrations/herdr.ts")

test("restart reclaims state after release despite clock rollback; reports finish in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-restart-"))
  try {
    const binary = join(dir, "herdr")
    const log = join(dir, "reports.jsonl")
    // Model Herdr's retained source sequence high-water marks and matching-owner release.
    // Slow working reports expose fire-and-forget delivery racing idle/release.
    writeFileSync(binary, `#!${process.execPath}
      import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
      const args = process.argv.slice(2);
      const value = flag => args[args.indexOf(flag) + 1];
      const source = value("--source"), seq = Number(value("--seq"));
      const verb = args[1], state = value("--state");
      if (verb === "report-agent" && state === "working") await Bun.sleep(70);
      const file = ${JSON.stringify(join(dir, "state.json"))};
      const data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { seqs: {}, owner: null, state: null };
      const accepted = seq > (data.seqs[source] ?? -1);
      if (accepted) {
        data.seqs[source] = seq;
        if (verb === "report-agent") { data.owner = source; data.state = state; }
        else if (data.owner === source) { data.owner = null; data.state = null; }
      }
      writeFileSync(file, JSON.stringify(data));
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({ source, seq, verb, state, accepted, owner: data.owner }) + "\\n");
    `)
    chmodSync(binary, 0o755)
    for (const clock of [9000, 1000]) {
      const code = `
        import { Effect } from "effect";
        Date.now = () => ${clock};
        const { reportState, releaseAgent } = await import(${JSON.stringify(integration)});
        await Effect.runPromise(Effect.gen(function* () {
          yield* reportState("idle");
          yield* Effect.all([reportState("working"), reportState("blocked"), reportState("idle")], { concurrency: "unbounded" });
          yield* releaseAgent;
        }));
      `
      const result = Bun.spawnSync([process.execPath, "-e", code], {
        env: { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: binary, HERDR_PANE_ID: "fake-pane", HERDR_SOCKET_PATH: "" },
      })
      expect(result.exitCode).toBe(0)
      expect(result.stderr.toString()).toBe("")
      const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))
      expect(state.owner).toBeNull()
    }
    const reports = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line))
    expect(reports).toHaveLength(10)
    expect(reports.every(r => r.accepted)).toBe(true)
    expect(reports[0].source).not.toBe(reports[5].source)
    for (const start of [0, 5]) {
      expect(reports.slice(start, start + 5).map(r => r.seq)).toEqual([1, 2, 3, 4, 5])
      expect(reports.slice(start, start + 4).map(r => r.state)).toEqual(["idle", "working", "blocked", "idle"])
      expect(reports[start + 4].verb).toBe("release-agent")
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 15000)

for (const mode of ["hang", "reject", "nonzero"]) {
  test(`Herdr ${mode} does not fail or permanently block reporting`, () => {
    const code = `
      import { Effect } from "effect";
      let spawned = 0, killed = false;
      Bun.spawn = () => {
        spawned++;
        return { exited: spawned > 1 ? Promise.resolve(0) : ${mode === "hang" ? "new Promise(() => {})" : mode === "reject" ? "Promise.reject(new Error('failed'))" : "Promise.resolve(1)"}, kill: () => { killed = true; } };
      };
      const { reportState, releaseAgent } = await import(${JSON.stringify(integration)});
      await Effect.runPromise(Effect.gen(function* () { yield* reportState("working"); yield* releaseAgent; }));
      console.log(JSON.stringify({ spawned, killed }));
    `
    const result = Bun.spawnSync([process.execPath, "-e", code], {
      env: { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: "/fake/herdr", HERDR_PANE_ID: "fake-pane" },
      timeout: 6000,
    })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({ spawned: 2, killed: mode === "hang" })
    expect(result.stderr.toString()).toContain("[herdr] Could not deliver agent state:")
  })
}
