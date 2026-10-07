import { expect, test } from "bun:test"
import { listLevel } from "../../src/system-one/explore"

const files = ["README.md", "package.json", "src/index.ts", "src/plugin/utc.ts", "src/plugin/duration/index.ts", "test/utc.test.ts"]

test("listLevel shows folders (files below + names inside) and files at one level", () => {
  expect(listLevel(files, "")).toEqual([
    { kind: "folder", path: "src", files: 3, sample: ["index.ts", "plugin"] },
    { kind: "folder", path: "test", files: 1, sample: ["utc.test.ts"] },
    { kind: "file", path: "README.md" },
    { kind: "file", path: "package.json" },
  ])
  expect(listLevel(files, "src/plugin")).toEqual([
    { kind: "folder", path: "src/plugin/duration", files: 1, sample: ["index.ts"] },
    { kind: "file", path: "src/plugin/utc.ts" },
  ])
})
