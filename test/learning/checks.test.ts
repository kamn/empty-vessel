import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { projectDir } from "../../src/base/project"
import { fillTemplate, loadChecks, saveCheck, vetCheck } from "../../src/learning/checks"

const check = (name: string, template: string, extra: object = {}) => ({ name, description: name, template, passes: 1, failsInARow: 0, ...extra })

test("loadChecks: general checks filtered by `requires`, project checks override by name, retired ones left out", async () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-")), root = mkdtempSync(join(tmpdir(), "empty-vessel-proj-"))
  writeFileSync(join(root, "package.json"), "{}")
  writeFileSync(join(home, "checks.json"), JSON.stringify([
    check("typecheck", "npx tsc --noEmit", { requires: ["package.json"] }),
    check("pnpm-test", "pnpm vitest run {file}", { requires: ["pnpm-lock.yaml"] }), // no pnpm-lock.yaml here
    check("lint", "npx eslint ."),
  ]))
  mkdirSync(projectDir(root, home), { recursive: true })
  writeFileSync(join(projectDir(root, home), "checks.json"), JSON.stringify([
    check("lint", "npx eslint src"),
    check("old", "npx mocha", { failsInARow: 3 }),
  ]))
  const found = await Effect.runPromise(loadChecks(root, home))
  expect(found.map((c) => `${c.scope}:${c.name}:${c.template}`)).toEqual(["general:typecheck:npx tsc --noEmit", "project:lint:npx eslint src"])
})

test("fillTemplate quotes arguments and names missing ones", () => {
  expect(fillTemplate("npx jest test/plugin/{plugin}.test.js", { plugin: "duration" })).toEqual({ command: "npx jest test/plugin/'duration'.test.js" })
  expect(fillTemplate("bun test {file}", { file: "a.ts; rm -rf ~" })).toEqual({ command: "bun test 'a.ts; rm -rf ~'" })
  expect(fillTemplate("bun test {file}", {})).toEqual({ missing: ["file"] })
  expect(fillTemplate("npx jest {files}", { files: ["a.test.js", "b.test.js"] })).toEqual({ command: "npx jest 'a.test.js' 'b.test.js'" }) // a list: one argument each
})

test("vetCheck: saves only an honest, read-only template that matches the command that passed", () => {
  const root = mkdtempSync(join(tmpdir(), "empty-vessel-proj-"))
  mkdirSync(join(root, "test/plugin"), { recursive: true })
  const save = (template: string, scope: "project" | "general" = "project") => ({ name: "t", description: "t", template, args: { plugin: "duration" }, scope })
  const cmd = "npx jest test/plugin/duration.test.js"
  expect(vetCheck(save("npx jest test/plugin/{plugin}.test.js"), cmd, root)).toBeUndefined()
  expect(vetCheck(save("npx jest test/{plugin}.test.js"), cmd, root)).toContain("isn't the command")
  expect(vetCheck(save("npx jest test/plugin/{plugin}.test.js || true"), `${cmd} || true`, root)).toContain("able to fail")
  expect(vetCheck(save("npx jest test/plugin/{plugin}.test.js > out.txt"), `${cmd} > out.txt`, root)).toContain("not change files")
  expect(vetCheck(save("npx jest test/plugin/{plugin}.test.js", "general"), cmd, root)).toContain("paths in this repo")
})

test("saveCheck: 10 saves at once all land (the lock), and each is in the history", async () => {
  const home = mkdtempSync(join(tmpdir(), "empty-vessel-home-")), root = mkdtempSync(join(tmpdir(), "empty-vessel-proj-"))
  const save = (i: number) => ({ name: `c${i}`, description: "d", template: `echo ${i}`, args: {}, scope: "project" as const })
  await Effect.runPromise(Effect.all(Array.from({ length: 10 }, (_, i) => saveCheck(root, save(i), "test", home)), { concurrency: "unbounded" }))
  const saved: Array<{ name: string }> = await Bun.file(join(projectDir(root, home), "checks.json")).json()
  expect(saved.map((c) => c.name).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `c${i}`).sort())
  const history = (await Bun.file(join(projectDir(root, home), "checks.log.jsonl")).text()).trim().split("\n")
  expect(history.length).toBe(10)
})
