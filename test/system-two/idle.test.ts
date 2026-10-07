import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { Events } from "../../src/base/events"
import { isTemporary } from "../../src/base/retry"
import { readWithin, withoutCitationMarks } from "../../src/plugins/codex/codex"

const bytes = (s: string) => new TextEncoder().encode(s)
const logged: Array<string> = []
const quiet = <A, E>(e: Effect.Effect<A, E>) => e.pipe(Effect.provideService(Events, { emit: (ev) => Effect.sync(() => { logged.push(ev.text) }) }))

test("a slow but steady reply is read in full: the limit is on silence, not on the total time", async () => {
  const steady = Stream.fromIterable(["event: a\n", "event: b\n", "event: c\n", "event: d\n"]).pipe(Stream.mapEffect((s) => Effect.sleep("80 millis").pipe(Effect.as(bytes(s)))))
  expect(await Effect.runPromise(quiet(readWithin(steady, "200 millis")))).toBe("event: a\nevent: b\nevent: c\nevent: d\n")
})

test("a reply that goes silent fails as a stall (worth a retry), and the log says so", async () => {
  const stalls = Stream.make(bytes("event: a\n")).pipe(Stream.concat(Stream.fromEffect(Effect.sleep("1 second").pipe(Effect.as(bytes("too late"))))))
  const error = await Effect.runPromise(quiet(readWithin(stalls, "150 millis")).pipe(Effect.flip))
  expect(error._tag).toBe("CodexStallError")
  expect(isTemporary(error)).toBe(true)
  expect(logged.at(-1)).toContain("sent nothing for")
  expect(logged.at(-1)).toContain("retrying")
})

test("Codex's citation marks after a web search are removed; its readable sources stay", () => {
  expect(withoutCitationMarks("v1.4.2 is the latest. citeturn0view0\nSee ([bun.sh](https://bun.sh/blog))")).toBe("v1.4.2 is the latest.\nSee ([bun.sh](https://bun.sh/blog))")
})
