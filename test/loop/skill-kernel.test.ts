import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect } from "effect"
import { ALL, type Grants } from "../../src/base/grants"
import { discoverSkills } from "../../src/base/skills"
import { makeKernel } from "../../src/kernel/kernel"
import { KERNEL_PASSTHROUGH } from "../../src/kernel/instructions-marker"
import { makeHost, makeKernelHook } from "../../src/loop/kernel"
import { builtinsModule, TSC } from "../../src/loop/library"
import { type Ctx, newConversation } from "../../src/loop/turnkit"
import { afterCommand, newCallState } from "../../src/system-two/dispatch"
import { kernelDescription, type Hooks } from "../../src/system-two/systemtwo"

const setup = (grants: Grants = { ...ALL, files: "read-only", shell: false }) => {
  const dir = mkdtempSync(join(tmpdir(), "skill-kernel-"))
  const home = join(dir, "home")
  const body = "FULL INSTRUCTIONS\n" + "never omit this line\n".repeat(400) + "END OF SKILL"
  for (const name of ["guide", "manual"]) {
    const folder = join(home, "skills", name)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: Test guide\n${name === "manual" ? "disable-model-invocation: true\n" : ""}---\n${body}\n$ARGUMENTS`)
  }
  const events: Array<{ role: string; text: string; data: unknown }> = []
  const ctx = { conversation: newConversation(), config: { kernel: { tools: grants } }, session: {
    dir, id: "skill-test", record: (role: string, text: string, data: unknown) => Effect.sync(() => { events.push({ role, text, data }) }),
  } } as unknown as Ctx
  ctx.conversation.skills = discoverSkills(dir, home)
  const services = Context.empty() as never
  const host = makeHost(ctx, services)
  const builtins = join(dir, "builtins.ts")
  writeFileSync(builtins, builtinsModule([], grants))
  const kernel = makeKernel({ dir: join(dir, "cells"), builtins, tsc: TSC, spareWorker: false })
  return { ctx, host, kernel, events, services, body, dir }
}

test("actual kernel skill builtin loads through Files, records and caches activation without widening grants", async () => {
  const { ctx, host, kernel, events, body } = setup()
  const catalog = ctx.conversation.skills
  const grants = { ...ctx.config.kernel.tools }
  const result = await Effect.runPromise(kernel.run('import { skill } from "kernel"; export default skill({ name: "guide", arguments: "specific task" })', host))
  expect(result.status).toBe("ok")
  const content = result.value as string
  expect(content).toContain("END OF SKILL")
  expect(JSON.parse(content).instructions).toBe(body + "\nspecific task")
  expect(ctx.conversation.activeSkills?.guide).toBe(content)
  expect(ctx.conversation.skills).toBe(catalog)
  expect(events).toEqual([{ role: "skill", text: "guide", data: { content } }])
  expect(ctx.config.kernel.tools).toEqual(grants)
  expect(await Effect.runPromise(kernel.run('import { bash } from "kernel"; export default bash("true")', host))).toMatchObject({ status: "type-error" })
}, 30000)

test("host validates input, unknown skills and forged user origin; failures do not activate", async () => {
  const { host, ctx, events, kernel } = setup()
  for (const arg of [null, [], "guide", {}, { name: "" }, { name: "guide", arguments: 1 }, { name: "missing" }, { name: "manual", origin: "user" }]) {
    await expect(Effect.runPromise(host.skill!(arg))).rejects.toBeDefined()
  }
  const result = await Effect.runPromise(kernel.run('import { skill } from "kernel"; export default skill({ name: "missing" })', host))
  expect(result.status).toBe("error")
  expect(result.error).toContain("Unknown skill")
  expect(Object.keys(ctx.conversation.activeSkills ?? {})).toEqual([])
  expect(events).toEqual([])
}, 30000)

test("skill discovery is lazy and cached even when lookup fails", async () => {
  const { ctx, host } = setup()
  ctx.conversation.skills = undefined
  expect(ctx.conversation.skills).toBeUndefined()
  await expect(Effect.runPromise(host.skill!({ name: "missing-test-skill" }))).rejects.toBeDefined()
  const catalog = ctx.conversation.skills
  expect(catalog).toBeDefined()
  await expect(Effect.runPromise(host.skill!({ name: "missing-test-skill" }))).rejects.toBeDefined()
  expect(ctx.conversation.skills).toBe(catalog)
})

test("no read grant excludes skill and host rejects bypass; remember cannot cache Files effects", async () => {
  const off = setup({ ...ALL, files: "none", shell: false })
  expect(kernelDescription(ALL)).toContain("skill({ name, arguments? })")
  expect(kernelDescription(off.ctx.config.kernel.tools)).not.toContain("skill(")
  await expect(Effect.runPromise(off.host.skill!({ name: "guide" }))).rejects.toThrow("read grant")
  expect(await Effect.runPromise(off.kernel.run('import { skill } from "kernel"; export default skill({ name: "guide" })', off.host))).toMatchObject({ status: "type-error" })
  const on = setup()
  expect(await Effect.runPromise(on.kernel.run('import { skill, remember } from "kernel"; export const cached = remember(skill({ name: "guide" })); export default cached', on.host))).toMatchObject({ status: "type-error" })
}, 30000)

test("skill bodies survive discarded results, summary truncation and dispatch pruning", async () => {
  const { ctx, services, body } = setup()
  const hook = makeKernelHook(ctx, services)
  const output = await Effect.runPromise(hook({ code: 'import { Effect, skill } from "kernel"; export default skill({ name: "guide" }).pipe(Effect.as("done"))', summary: "Load guide" }))
  const envelope = ctx.conversation.activeSkills!.guide!
  expect(JSON.parse(envelope).instructions).toContain(body)
  expect(output).toContain(KERNEL_PASSTHROUGH)
  expect(output).toContain(envelope)
  let pruned = false
  const hooks = { prune: () => Effect.sync(() => { pruned = true; return "removed" }) } as unknown as Hooks
  const returned = await Effect.runPromise(afterCommand("kernel", {}, output, hooks, newCallState()))
  expect(pruned).toBe(false)
  expect(returned).toBe(output)
}, 30000)
