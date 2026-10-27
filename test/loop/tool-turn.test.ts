import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { Config, ConfigSchema } from "../../src/base/config"
import { Events } from "../../src/base/events"
import { Memory } from "../../src/base/memory"
import { makeSession } from "../../src/base/session"
import { diskStore } from "../../src/base/store"
import { Usage } from "../../src/base/usage"
import { scopeFor } from "../../src/kernel/kernel"
import { BUILTINS, libraryDir, saveLibrary } from "../../src/loop/library"
import { turn } from "../../src/loop/turn"
import { newConversation, type Needs } from "../../src/loop/turnkit"
import { SystemOne } from "../../src/system-one/systemone"
import { FakeSystemTwo, SystemTwo } from "../../src/system-two/systemtwo"
import { AskUser } from "../../src/ui/ask"

// Neither system may be asked anything: "/tool <name>" runs the tool and nothing else.
const untouchable = <S extends object>(what: string) => new Proxy({}, { get: () => () => Effect.die(`${what} was called`) }) as S

test("/tool <name> runs that library tool alone: its value is the reply, no System One choice, no System Two", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tool-turn-"))), cwd = process.cwd()
  const config = Schema.decodeUnknownSync(ConfigSchema)({ learnAfterTurn: false, kernel: { tools: { sources: false } } })
  process.chdir(root)
  const dir = libraryDir(root)

  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "scope.ts"), scopeFor([], BUILTINS))
    writeFileSync(join(dir, "checkin.ts"), `import { Effect } from "./scope.ts"\nexport const checkin = (_request: string) => Effect.succeed("🌱 daily check-in\\nDid you?")\n`)
    saveLibrary(dir, [{ name: "checkin", description: "The daily check-in", file: join(dir, "checkin.ts"), from: "test" }])

    await Effect.runPromise(Effect.gen(function* () {
      const session = yield* makeSession("sessions")
      expect(yield* turn(session, "/tool checkin", 0, newConversation())).toBe("🌱 daily check-in\nDid you?")
      expect(yield* turn(session, "/tool missing", 0, newConversation())).toBe("/tool missing failed: no System One tool named missing here (checkin)")

      const roles = readFileSync(join(session.dir, "main.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).role)
      expect(roles).not.toContain("decision") // System One never chose
    }).pipe(
      Effect.provideService(Config, config),
      Effect.provideService(Events, { emit: () => Effect.void }),
      Effect.provideService(AskUser, { ask: () => Effect.succeed([]) }),
      Effect.provideService(Memory, { snapshot: Effect.succeed(""), add: () => Effect.void, replace: () => Effect.void, remove: () => Effect.void, entries: () => Effect.succeed([]), file: () => Effect.succeed("") }),
      Effect.provide(Layer.succeed(SystemOne, untouchable<SystemOne["Service"]>("System One"))),
      Effect.provide(FakeSystemTwo), Effect.provideService(SystemTwo, { ...untouchable<SystemTwo["Service"]>("System Two") }),
      Effect.provide(Usage.layer), Effect.provide(diskStore(root)),
      Effect.provideContext(Context.empty() as Context.Context<Needs>),
    ))
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
    rmSync(join(dir, ".."), { recursive: true, force: true }) // the project's folder under the empty-vessel home
  }
}, 30_000)
