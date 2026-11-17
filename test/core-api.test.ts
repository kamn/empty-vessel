import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { CORE_VERSION } from "../src/core"
import { apiFile, changes, DOORS, needed, render, versionOf } from "../scripts/core-api"

// core-api.txt is what the core promises plugins (src/core.ts's exports and the config's schema), host-api.txt what it
// promises hosts (src/host.ts's exports: empty-vessel-agent). A change to either without rewriting its file fails here,
// saying what changed and which version it needs; the rewrite (bun scripts/core-api.ts --write) is refused until
// CORE_VERSION is bumped that far.
test.each(DOORS)("%s-api.txt matches the core, and its version is CORE_VERSION", (door) => {
  const committed = readFileSync(apiFile(door), "utf8"), now = render(versionOf(committed), door)
  const c = changes(committed, now)
  const why = `the core's API changed (added ${c.added.join(", ") || "nothing"}; removed ${c.removed.join(", ") || "nothing"}; changed ${c.changed.join(", ") || "nothing"}): set CORE_VERSION to at least ${needed(versionOf(committed), c)} in src/base/version.ts, then run bun scripts/core-api.ts --write`
  expect(now === committed ? "" : why).toBe("")
  expect(versionOf(committed)).toBe(CORE_VERSION)
}, 60_000)

test("the bump a change needs: at 0.0.x every change the patch; below 1.0 breaking the minor, an addition the patch; from 1.0 the major and minor", () => {
  const api = (blocks: Record<string, string>) => `# empty-vessel core 0.0.0\n\n${Object.entries(blocks).map(([k, v]) => `## ${k} (src/x)\n${v}\n`).join("\n")}`
  const before = api({ A: "export type A = string;", B: "export type B = number;" })
  expect(needed("0.0.4", changes(before, api({ A: "export type A = string;" })))).toBe("0.0.5") // breaking, still a patch
  expect(needed("0.0.4", changes(before, api({ A: "export type A = string;", B: "export type B = number;", C: "x" })))).toBe("0.0.5")
  expect(needed("0.3.2", changes(before, before))).toBe("0.3.2")
  expect(needed("0.3.2", changes(before, api({ A: "export type A = string;", B: "export type B = number;", C: "x" })))).toBe("0.3.3")
  expect(needed("0.3.2", changes(before, api({ A: "export type A = string;" })))).toBe("0.4.0")
  expect(needed("0.3.2", changes(before, api({ A: "export type A = boolean;", B: "export type B = number;" })))).toBe("0.4.0")
  expect(needed("1.2.3", changes(before, api({ A: "export type A = string;", B: "export type B = number;", C: "x" })))).toBe("1.3.0")
  expect(needed("1.2.3", changes(before, api({ A: "export type A = string;" })))).toBe("2.0.0")
})
