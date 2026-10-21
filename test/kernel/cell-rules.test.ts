import { expect, test } from "bun:test"
import { cellProblems } from "../../src/kernel/rules"

const head = `import { Effect } from "kernel"\n`

test("cellProblems: a regular expression's insides aren't code; a quote in one doesn't hide what follows", () => {
  expect(cellProblems(`${head}const re = /don't/\nexport default Effect.succeed('use fetch here'.match(re))`)).toEqual([])
  expect(cellProblems(`${head}const re = /"/\nexport default Effect.sync(() => fetch("x"))\nconst s = "a"`).join("\n")).toContain("fetch")
  expect(cellProblems(`${head}export const digits = /\\d{3}/g\nexport default Effect.succeed(1)`)).toEqual([]) // its braces aren't depth
  expect(cellProblems(`${head}export const half = (n: number) => n / 2 / 1\nexport default Effect.succeed(half(4))`)).toEqual([]) // division stays
})

test("cellProblems: await in an async arrow's expression body isn't top-level work; real top-level await still is", () => {
  expect(cellProblems(`${head}export const f = async (x: Promise<number>) => await x\nexport default Effect.succeed(1)`)).toEqual([])
  expect(cellProblems(`${head}const x = await Promise.resolve(1)\nexport default Effect.succeed(x)`).join("\n")).toContain("await at the top level")
})

test("cellProblems: the rules still catch the time and timers", () => {
  expect(cellProblems(`${head}export default Effect.sync(() => Date.now())`).join("\n")).toContain("Date.now")
  expect(cellProblems(`${head}export default Effect.sync(() => setTimeout(() => {}, 1))`).join("\n")).toContain("timers")
})
