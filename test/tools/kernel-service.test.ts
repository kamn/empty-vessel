import { expect, test } from "bun:test"
import { Effect } from "effect"
import { userCommand } from "../../src/answer"
import { Kernel, type KernelService } from "../../src/tools/kernel-service"
import { packFiles, projectFiles } from "../../src/system-one/explore"

// A kernel whose world is a made-up project: if Gather and !command reach the project any other way, these fail.
const world: Record<string, string> = { "src/money.ts": "export const add = (a: number, b: number) => a + b", "README.md": "# shop" }
const ran: Array<string> = []
const fake: KernelService = {
  open: () => { throw new Error("no cells here") },
  exec: (command) => Effect.sync(() => { ran.push(command); return "exit 0\nfrom the kernel's world" }),
  files: {
    list: () => Effect.succeed(Object.keys(world)),
    grep: (_, word) => Effect.succeed(Object.keys(world).filter((f) => world[f]!.toLowerCase().includes(word.toLowerCase()))),
    read: (_, path) => Effect.succeed(world[path]),
    size: (_, path) => Effect.succeed(world[path]?.length ?? 0),
  },
}
const inWorld = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e.pipe(Effect.provideService(Kernel, fake)))

test("Gather reads the project through the kernel: its file list and the files it packs for System Two", async () => {
  expect(await inWorld(projectFiles("/nowhere"))).toEqual(["src/money.ts", "README.md"])
  expect(await inWorld(packFiles("/nowhere", ["src/money.ts"]))).toBe(`<file path="src/money.ts">\n${world["src/money.ts"]}\n</file>`)
})

test("!command runs through the kernel's exec (the world the agent sees); !! only shows it", async () => {
  const output = await inWorld(userCommand(undefined as never, undefined as never, "ls src", false))
  expect(output).toBe("exit 0\nfrom the kernel's world")
  expect(ran).toEqual(["ls src"])
})
