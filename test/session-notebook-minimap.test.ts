import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parseSession, renderSession } from "../scripts/session-notebook"
import { minimapScript } from "../scripts/session-notebook-minimap"

const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

test("minimap uses a single canvas, escaped data, and a hash-restricted UI script", () => {
  const rows = parseSession(Array.from({ length: 10_000 }, (_, i) => JSON.stringify({ role: i % 2 ? "thread" : "user", text: `record ${i} </script><script>BAD()</script>`, ts: i })).join("\n"))
  const html = renderSession("/large/main.jsonl", rows)
  expect(html.match(/<canvas /g)).toHaveLength(1)
  expect(html.match(/role="slider"/g)).toHaveLength(1)
  expect(html).toContain('aria-valuemax="10000"')
  expect(html).toContain('href="#event-10000"')
  expect(html).not.toContain('<script>BAD()')
  expect(html).not.toContain('class="marker"')
  expect(html).not.toContain('overflow-y:auto')
  expect(html).toContain(`script-src 'sha256-${createHash("sha256").update(minimapScript).digest("base64")}'`)
})

// Real layout, CSP, pointer, focus, and keyboard behavior; no browser package or network needed.
function probe() {
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
  const run = async () => {
    const rail = document.querySelector<HTMLElement>(".minimap")!
    const aside = rail.parentElement!
    const entries = JSON.parse(rail.dataset.entries!) as { line: number }[]
    const box = rail.getBoundingClientRect()
    check(box.height > 0, "minimap has usable height")
    check(aside.scrollHeight <= aside.clientHeight + 1, "rail never needs scrolling")
    check(box.top >= 0 && box.bottom <= innerHeight, "entire history fits viewport")
    check(document.documentElement.scrollWidth <= innerWidth, "narrow layout fits horizontally")
    check(rail.querySelectorAll("canvas").length === 1, "one canvas regardless of history size")
    if (!entries.length) {
      check(rail.getAttribute("aria-disabled") === "true", "empty state initialized")
      return
    }
    check(rail.getAttribute("aria-valuetext")?.includes("1 of"), "CSP permitted trusted script")
    const key = (value: string) => rail.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }))
    rail.focus({ preventScroll: true })
    key("End")
    check(location.hash === `#event-${entries.at(-1)!.line}`, "End reaches final record")
    check(document.activeElement === rail, "keyboard focus remains on minimap after jump")
    const last = document.getElementById(`event-${entries.at(-1)!.line}`)!
    const folded = last.querySelector<HTMLDetailsElement>("details.quiet")
    if (folded) check(folded.open, "jump unfolds quiet target")
    key("Home")
    check(location.hash === `#event-${entries[0]!.line}`, "Home reaches first record")
    key("ArrowDown")
    check(rail.getAttribute("aria-valuenow") === String(Math.min(2, entries.length)), "arrows reach individual records")
    key("Home")
    const rect = rail.getBoundingClientRect()
    const middle = Math.round((entries.length - 1) / 2)
    rail.dispatchEvent(new PointerEvent("pointerdown", { clientY: rect.top + rect.height / 2, button: 0, bubbles: true, cancelable: true }))
    check(location.hash === `#event-${entries[middle]!.line}`, "midpoint maps to chronological middle")
    rail.dispatchEvent(new PointerEvent("pointermove", { clientY: rail.getBoundingClientRect().top, bubbles: true }))
    const tooltip = document.querySelector<HTMLElement>("#minimap-tip")!
    check(!tooltip.hidden && tooltip.textContent!.includes("record 1"), "hover retains timestamp and usage details")
    key("Escape")
    check(tooltip.hidden, "Escape dismisses tooltip")
    aside.querySelectorAll<HTMLAnchorElement>("a")[1]!.click()
    check(location.hash === `#event-${entries.at(-1)!.line}`, "End link reaches last record")
    rail.dispatchEvent(new PointerEvent("pointerdown", { clientY: rail.getBoundingClientRect().top, button: 0, bubbles: true, cancelable: true }))
    check(location.hash === `#event-${entries[0]!.line}`, "topmost click reaches first record")
    rail.dispatchEvent(new PointerEvent("pointerdown", { clientY: rail.getBoundingClientRect().bottom, button: 0, bubbles: true, cancelable: true }))
    check(location.hash === `#event-${entries.at(-1)!.line}`, "bottommost click reaches final record")
    await new Promise(resolve => setTimeout(resolve, 100))
    check(aside.scrollHeight <= aside.clientHeight + 1, "rail still fits after navigation")
    check(rail.getAttribute("aria-valuenow") === String(entries.length), "scroll tracking preserves final position")
  }
  run().then(() => document.body.setAttribute("data-probe", "PASS"), error => document.body.setAttribute("data-probe", `FAIL: ${error.message}`))
}

for (const [name, width, height, count] of [
  ["large desktop", 1280, 900, 5000],
  ["narrow", 390, 844, 300],
  ["short viewport", 1280, 350, 200],
  ["empty", 390, 844, 0],
  ["single record", 1280, 900, 1],
] as const) {
  test.skipIf(!existsSync(chrome))(`minimap browser: ${name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "notebook-minimap-"))
    try {
      const rows = parseSession(Array.from({ length: count }, (_, i) => JSON.stringify({ role: i % 2 || count === 1 ? "thread" : "user", text: `Saved record ${i}`, ts: i })).join("\n"))
      const script = `(${probe.toString()})();`
      const hash = createHash("sha256").update(script).digest("base64")
      const html = renderSession("/fixture/main.jsonl", rows)
        .replace("; style-src", ` 'sha256-${hash}'; style-src`)
        .replace("</body>", `<script>${script}</script></body>`)
      const path = join(dir, "report.html")
      writeFileSync(path, html)
      const proc = Bun.spawn([chrome, "--headless", "--no-sandbox", "--no-first-run", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--disable-default-apps", "--metrics-recording-only", `--user-data-dir=${join(dir, "profile")}`, `--window-size=${width},${height}`, "--virtual-time-budget=1500", "--dump-dom", pathToFileURL(path).href], { stdout: Bun.file(join(dir, "dom.html")), stderr: Bun.file(join(dir, "chrome.log")) })
      try {
        let outcome: string | undefined
        // Chrome can keep background helpers alive after dumping the completed DOM.
        // Wait for the explicit in-page result, then close this isolated browser.
        for (let attempt = 0; attempt < 400 && outcome === undefined; attempt++) {
          await Bun.sleep(50)
          const out = readFileSync(join(dir, "dom.html"), "utf8")
          outcome = out.match(/data-probe="([^"]*)"/)?.[1]
        }
        expect(outcome ?? readFileSync(join(dir, "chrome.log"), "utf8").slice(-1000)).toBe("PASS")
      } finally { proc.kill(); await proc.exited }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 30_000)
}
