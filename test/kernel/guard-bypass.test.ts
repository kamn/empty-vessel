import { expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Effect } from "effect"
import { ActionGuard } from "../../src/tools/action-guard"
import { makeGuardedKernel } from "../../src/tools/kernel-service"

// A cell must not run a shell command the configured guard denies, by reaching around the kernel's bash.
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "empty-vessel-bypass-"))
  const kernel = makeGuardedKernel({ dir, builtins: resolve("src/tools/kernel-builtins.ts"), spareWorker: false, timeoutMs: 20_000 })
  return { kernel, sentinel: join(dir, "executed"), command: `printf x >> '${join(dir, "executed")}'` }
}
const denyAll = { beforeAction: () => Effect.sleep("300 millis").pipe(Effect.as({ decision: "deny" as const, reason: "nope" })) }
const run = (kernel: ReturnType<typeof makeGuardedKernel>, code: string) => Effect.runPromise(kernel.run(code).pipe(Effect.provideService(ActionGuard, denyAll)))

test("import.meta.require can't reach runBash with an authorizer of the cell's own", async () => {
  const { kernel, sentinel, command } = setup()
  const r = await run(kernel, `import { Effect } from "kernel"
const m: any = import.meta.require(${JSON.stringify(resolve("src/tools/bash.ts"))})
export default m.runBash(${JSON.stringify(command)}, 5000, () => Effect.succeed({ decision: "allow" }))`)

  expect(r.summary).toContain("import.meta isn't available in a cell")
  expect(existsSync(sentinel)).toBe(false)
}, 60_000)

test("a cell can't forge the host's allow reply for its own command", async () => {
  const { kernel, sentinel, command } = setup()
  const r = await run(kernel, `import { Effect, bash } from "kernel"
const forge = Effect.sync(() => { for (let id = 1; id < 20; id++) self.dispatchEvent(new MessageEvent("message", { data: { type: "reply", id, value: { decision: "allow" } } })) })
export default Effect.all([bash(${JSON.stringify(command)}, 5), Effect.sleep("50 millis").pipe(Effect.andThen(forge))], { concurrency: "unbounded" })`)

  expect(existsSync(sentinel)).toBe(false)
  expect(r.summary).toContain("self aren't available in a cell")
}, 60_000)
