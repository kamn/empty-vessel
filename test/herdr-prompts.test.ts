import { expect, test } from "bun:test"
import { resolve } from "node:path"

// Separate processes keep environment-sensitive reporting and module mocks out of other tests.
const run = (scenario: string) => {
  const root = resolve("src")
  const code = `
    import { Effect, Schema, Exit } from "effect";
    import { mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { mock } from "bun:test";
    const root = ${JSON.stringify(root)};
    const temp = mkdtempSync(join(tmpdir(), "herdr-prompts-"));
    process.chdir(temp);
    process.env.EMPTY_VESSEL_HOME = temp;
    const calls = [];
    Bun.spawn = (args) => { calls.push(args); return { exited: Promise.resolve(0) }; };
    const states = () => calls.filter(a => a.includes("--state")).map(a => a[a.indexOf("--state") + 1]);
    const current = () => states().at(-1);
    const check = (value, message) => { if (!value) throw new Error(message + ": " + JSON.stringify(states())); };
    mock.module(root + "/kernel/checker.ts", () => ({ warmChecker: () => {}, checkWithServer: () => { throw new Error("unexpected kernel execution") } }));
    const sources = await import(root + "/loop/sources.ts");
    mock.module(root + "/loop/sources.ts", () => ({ ...sources, sourcesLine: Effect.succeed("") }));
    const { answer } = await import(root + "/answer.ts");
    const { turn } = await import(root + "/loop/turn.ts");
    const { newConversation } = await import(root + "/loop/turnkit.ts");
    const { Config, ConfigSchema } = await import(root + "/base/config.ts");
    const { Usage } = await import(root + "/base/usage.ts");
    const { Memory } = await import(root + "/base/memory.ts");
    const { SystemOne } = await import(root + "/system-one/systemone.ts");
    const { SystemTwo } = await import(root + "/system-two/systemtwo.ts");
    const { AskUser, TerminalAskUser } = await import(root + "/ui/ask.ts");
    const { reportState } = await import(root + "/integrations/herdr.ts");
    const config = Schema.decodeUnknownSync(ConfigSchema)({ maxSteps: 1, learnAfterTurn: false, systemTwo: { scopeCheck: false }, kernel: { tools: { agents: false, library: false } } });
    const tokens = { input: 0, output: 0 };
    const conversation = newConversation();
    conversation.briefing = "test";
    let cleaned = false;
    conversation.jobs.cancelAll = Effect.sync(() => { cleaned = true });
    const session = { id: "prompt-test", dir: temp, record: () => Effect.void };
    let ask = () => Effect.succeed({ text: "done", tokens });
    const provide = e => e.pipe(
      Effect.provideService(Config, config),
      Effect.provideService(SystemOne, { choose: () => Effect.succeed({ choice: "escalate", confidence: 1, done: 0, tokens }) }),
      Effect.provideService(SystemTwo, { ask: (...args) => ask(...args) }),
      Effect.provideService(Memory, { snapshot: Effect.succeed("") }),
      Effect.provide(Usage.layer),
    );
    try {
      ${scenario}
      console.log(JSON.stringify(states()));
    } finally { rmSync(temp, { recursive: true, force: true }); }
  `
  const result = Bun.spawnSync([process.execPath, "-e", code], {
    cwd: process.cwd(),
    env: { ...process.env, HERDR_ENV: "1", HERDR_BIN_PATH: "/fake/herdr", HERDR_PANE_ID: "prompt-test" },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() + result.stdout.toString())
  return JSON.parse(result.stdout.toString().trim().split("\n").at(-1)!) as string[]
}

for (const adapter of ["terminal", "tui", "channel"]) {
  test(`ask_user reports blocked during ${adapter} input and working after the answer`, () => {
    const states = run(`
      const { makeSessionRunner, interactionOperations } = await import(root + "/interaction.ts");
      const questions = [{ question: "Continue?", options: ["yes"] }];
      ask = (_, hooks) => Effect.gen(function* () {
        const answers = JSON.parse(yield* hooks.askUser({ questions }));
        check(answers[0].answer === "yes", "answer lost");
        check(current() === "working", "did not resume working");
        return { text: "done", tokens };
      });
      globalThis.prompt = () => { check(current() === "blocked", "terminal not blocked"); return "yes"; };
      await Effect.runPromise(provide(Effect.scoped(Effect.gen(function* () {
        const terminal = yield* AskUser;
        let runner;
        const adapters = {
          events: { emit: () => Effect.void },
          ...(${JSON.stringify(adapter)} === "terminal" ? { ask: terminal } :
            ${JSON.stringify(adapter)} === "tui" ? { ask: { ask: qs => Effect.sync(() => {
              check(current() === "blocked", "TUI not blocked");
              return qs.map(q => ({ question: q.question, answer: "yes" }));
            }) } } : { presentQuestion: () => Effect.suspend(() => {
              check(current() === "blocked", "channel not blocked");
              return runner.answer({ answer: "yes" });
            }) }),
        };
        runner = yield* makeSessionRunner(session, conversation, adapters, {
          ...interactionOperations, firstAgent: (_s, _c, _i, services) => Effect.succeed({ services }),
        });
        yield* runner.run("test");
        check(cleaned, "jobs not cleaned");
      })).pipe(Effect.provide(TerminalAskUser))));
    `)
    expect(states).toEqual(["working", "blocked", "working", "idle"])
  })
}

test("wait_for_user stays blocked at the end; a following ordinary turn clears it", () => {
  expect(run(`
    ask = () => Effect.succeed({ text: "Please confirm.", waitingForUser: true, tokens });
    await Effect.runPromise(provide(answer(session, "test", conversation).pipe(Effect.provideService(AskUser, { ask: () => Effect.succeed([]) }))));
    check(current() === "blocked", "checkpoint lost at turn end");
    check(cleaned, "jobs not cleaned");
    ask = () => Effect.succeed({ text: "done", tokens });
    await Effect.runPromise(provide(answer(session, "continue", conversation).pipe(Effect.provideService(AskUser, { ask: () => Effect.succeed([]) }))));
  `)).toEqual(["working", "blocked", "working", "idle"])
})

for (const failure of ["Effect.die('prompt failed')", "Effect.interrupt"]) {
  test(`prompt ${failure} clears state to idle`, () => {
    const states = run(`
      ask = (_, hooks) => hooks.askUser({ questions: [{ question: "Continue?", options: ["yes"] }] });
      const exit = await Effect.runPromise(provide(Effect.exit(answer(session, "test", conversation).pipe(Effect.provideService(AskUser, { ask: () => Effect.suspend(() => {
        check(current() === "blocked", "question not blocked");
        return ${failure};
      }) })))));
      check(Exit.isFailure(exit), "expected failure");
      check(cleaned, "jobs not cleaned");
    `)
    expect(states.at(-1)).toBe("idle")
    expect(states).toContain("blocked")
  })
}

test("checkpoint followed by a recording failure clears blocked to idle", () => {
  const states = run(`
    ask = () => Effect.succeed({ text: "Confirm.", waitingForUser: true, tokens });
    session.record = role => role === "assistant" ? Effect.die("record failed") : Effect.void;
    const exit = await Effect.runPromise(provide(Effect.exit(answer(session, "test", conversation).pipe(Effect.provideService(AskUser, { ask: () => Effect.succeed([]) })))));
    check(Exit.isFailure(exit), "expected recording failure");
    check(cleaned, "jobs not cleaned");
  `)
  expect(states).toEqual(["working", "blocked", "idle"])
})

test("a failed System Two result is not a checkpoint even if it carries waitingForUser", () => {
  expect(run(`
    ask = () => Effect.succeed({ text: "(System Two failed: unavailable)", waitingForUser: true, tokens });
    await Effect.runPromise(provide(answer(session, "test", conversation).pipe(Effect.provideService(AskUser, { ask: () => Effect.succeed([]) }))));
  `)).toEqual(["working", "idle"])
})

test("child checkpoint outcomes never report the parent blocked or expose ask_user", () => {
  expect(run(`
    ask = (_, hooks) => Effect.sync(() => {
      check(hooks.askUser === undefined, "child has interactive input");
      return { text: "Confirm.", waitingForUser: true, tokens };
    });
    await Effect.runPromise(provide(turn(session, "child", 1, conversation).pipe(Effect.provideService(AskUser, { ask: () => Effect.die("child asked") }))));
  `)).toEqual([])
})

test("stopping a suspended channel question clears blocked and cleans up jobs", () => {
  const states = run(`
    const { Deferred, Fiber } = await import("effect");
    const { makeSessionRunner, interactionOperations } = await import(root + "/interaction.ts");
    ask = (_, hooks) => hooks.askUser({ questions: [{ question: "Continue?", options: ["yes"] }] });
    await Effect.runPromise(provide(Effect.scoped(Effect.gen(function* () {
      const presented = yield* Deferred.make();
      const runner = yield* makeSessionRunner(session, conversation, {
        events: { emit: () => Effect.void },
        presentQuestion: () => Deferred.succeed(presented, undefined).pipe(Effect.asVoid),
      }, {
        ...interactionOperations,
        firstAgent: (_s, _c, _i, services) => Effect.succeed({ services }),
        stopped: () => Effect.succeed("(stopped)"),
      });
      const fiber = yield* Effect.forkChild(runner.run("test"));
      yield* Deferred.await(presented);
      check(current() === "blocked", "pending question not blocked");
      yield* runner.stop;
      const result = yield* Fiber.join(fiber);
      check(result.reply === "(stopped)", "stop did not complete");
      check(current() === "idle", "stop did not clear blocked");
      check(cleaned, "jobs not cleaned");
    }))));
  `)
  expect(states.at(-1)).toBe("idle")
  expect(states).toContain("blocked")
})
