import { expect, test } from "bun:test"
import { ALL } from "../../src/base/grants"
import { builtinsModule } from "../../src/loop/library"
import { KERNEL_INSTRUCTIONS, kernelInstructions } from "../../src/system-two/instructions"

// The graph built-ins are told of only with the graph memory on (memory.use = graph) and the library granted.
test("System Two is told of the graph built-ins only when the graph is on", () => {
  expect(kernelInstructions(ALL)).toBe(KERNEL_INSTRUCTIONS)
  expect(KERNEL_INSTRUCTIONS).not.toContain("graph.")
  expect(kernelInstructions(ALL, true)).toContain("graph.query(")
  expect(kernelInstructions(ALL, true)).toContain("graph.add(")
  expect(kernelInstructions({ ...ALL, library: false }, true)).not.toContain("graph.")
})

test("graph is part of the library grant", () => {
  expect(builtinsModule([], ALL)).toMatch(/\bgraph\b/)
  expect(builtinsModule([], { ...ALL, library: false }).split(" from ")[0]).not.toMatch(/\bgraph\b/)
})
