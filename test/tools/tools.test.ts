import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { truncateTail } from "../../src/tools/bash"
import { applyEdits, readLines } from "../../src/tools/tools"

const lines = (n: number, width = 5) => Array.from({ length: n }, (_, i) => `${i + 1}`.padEnd(width, "x")).join("\n")

test("readLines: pages with offset/limit and says where to continue", () => {
  const text = lines(5000)
  expect(readLines(text, 1)).toEndWith("[Showing lines 1-2000 of 5000. Use offset=2001 to continue.]") // 2000-line cap
  expect(readLines(text, 10, 3)).toBe("10xxx\n11xxx\n12xxx\n\n[Showing lines 10-12 of 5000. Use offset=13 to continue.]")
  expect(readLines("a\nb\n", 1)).toBe("a\nb") // a final newline ends the last line; it doesn't start a new one
  expect(readLines("a\nb", 5)).toBe("offset 5 is past the end of the file (2 lines)")
  expect(readLines(lines(100, 1000), 1)).toContain("[Showing lines 1-51 of 100. Use offset=52 to continue.]") // 50 KB cap
})

test("applyEdits: every oldText matched once against the original; clear errors otherwise", () => {
  const text = "const a = 1\nconst b = 2\nconst c = 3"
  expect(applyEdits(text, "f.ts", [{ oldText: "const a = 1", newText: "const a = 100" }, { oldText: "const c = 3", newText: "const c = 30" }]))
    .toEqual({ result: "const a = 100\nconst b = 2\nconst c = 30", lines: [1, 3] })
  // matched against the original: edit 1 creates "b = 3"… but edit 2 still means the original "c = 3"
  expect(applyEdits("b = 2\nc = 3", "f.ts", [{ oldText: "b = 2", newText: "b = 3" }, { oldText: "c = 3", newText: "c = 4" }]))
    .toEqual({ result: "b = 3\nc = 4", lines: [1, 2] })
  expect(applyEdits(text, "f.ts", [{ oldText: "nope", newText: "x" }])).toEqual({ error: "edits[0].oldText was not found in f.ts. It must match the file exactly, including whitespace and indentation." })
  expect(applyEdits("x\nx", "f.ts", [{ oldText: "x", newText: "y" }])).toEqual({ error: "edits[0].oldText occurs 2 times in f.ts. It must be unique: include more surrounding lines." })
  expect(applyEdits(text, "f.ts", [{ oldText: "", newText: "y" }]).error).toStartWith("edits[0].oldText is empty.")
  expect(applyEdits(text, "f.ts", [{ oldText: "const a = 1\nconst b", newText: "x" }, { oldText: "const b = 2", newText: "y" }]).error)
    .toBe("edits[0] and edits[1] overlap in f.ts. Merge them into one edit or target separate regions.")
})

test("truncateTail: keeps the end (the verdict), saves the full output, and handles one huge line", () => {
  expect(truncateTail("short")).toBe("short")

  const long = lines(3000)
  const cut = truncateTail(long)
  expect(cut).toStartWith("1001x\n")
  const note = cut.split("\n").at(-1)!
  expect(note).toStartWith("[Showing lines 1001-3000 of 3000. Full output: ")
  expect(readFileSync(note.match(/Full output: (.*)]$/)![1]!, "utf8")).toBe(long)

  const huge = "y".repeat(60 * 1024)
  expect(truncateTail(huge)).toContain("[Showing the end of line 1 of 1.")
})

test("runBash: a timeout kills the whole command, children included", async () => {
  const { Effect } = await import("effect")
  const { runBash } = await import("../../src/tools/bash")
  const out = await Effect.runPromise(runBash("sleep 7.3 & sleep 7.3; echo never", 500))
  expect(out).toContain("timed out after 0.5s")
  expect(Bun.spawnSync(["pgrep", "-fx", "sleep 7.3"]).exitCode).toBe(1) // no sleep left behind
})
