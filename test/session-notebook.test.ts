import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { parseSession, renderSession, pickSession, listSessions, recentSessions, main } from "../scripts/session-notebook"

const dirs: string[] = []
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), "session-viewer-")); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

test("preserves source order, unknown roles, blank line positions and malformed records", () => {
  const rows = parseSession('{"role":"user","text":"first","ts":2}\n\ninvalid\n{"role":"future-role","text":"last","ts":1}')
  expect(rows.map(r => r.line)).toEqual([1, 3, 4])
  expect(rows[1]!.malformed).toBe(true)
  expect(rows[2]!.role).toBe("future-role")
})

test("escapes untrusted content and clearly identifies missing inventory and coverage", () => {
  const payload = '<script>alert("x")</script>'
  const html = renderSession('/private/session/main.jsonl', parseSession(JSON.stringify({ role: payload, text: payload, ts: 1e30 })), ['child-1'])
  expect(html).not.toContain(payload)
  expect(html.match(/<script>/g)).toHaveLength(1)
  expect(html).toContain("script-src 'sha256-")
  expect(html).toContain('&lt;script&gt;')
  expect(html).toContain('Time not recorded')
  expect(html).toContain('startup inventory not established')
  expect(html).toContain('Kernel sidecar files are not imported')
  expect(html).toContain('child-1')
  expect(html).toContain("default-src 'none'")
  expect(html.indexOf('id="setup"')).toBeLessThan(html.indexOf('id="event-1"'))
})

test("random selection accepts every candidate and rejects empty pools", () => {
  expect(pickSession(['a', 'b'], () => 0)).toBe('a')
  expect(pickSession(['a', 'b'], () => 1)).toBe('b')
  expect(() => pickSession([])).toThrow('No nonempty')
})

test("recent selection uses recorded timestamps, not filenames or modification dates", () => {
  const root = fixture()
  for (const [id, ts] of [['z-old', 1], ['a-new', 30], ['b-middle', 20]] as const) {
    mkdirSync(join(root, id))
    writeFileSync(join(root, id, 'main.jsonl'), JSON.stringify({ role: 'user', text: id, ts }))
  }
  expect(recentSessions(listSessions(root), 2)).toEqual([join(root, 'a-new/main.jsonl'), join(root, 'b-middle/main.jsonl')])
  expect(() => recentSessions([], 0)).toThrow('positive integer')
})

test("CLI renders a recent sample and refuses to overwrite existing files", () => Effect.runPromise(Effect.gen(function* () {
  const root = fixture()
  const dir = join(root, 'example')
  mkdirSync(dir)
  writeFileSync(join(dir, 'main.jsonl'), JSON.stringify({ role: 'assistant', text: 'saved answer', ts: 42 }))
  const output = join(root, 'report.html')
  yield* main(['--random', '--recent', '1', '--root', root, '--output', output])
  expect(readFileSync(output, 'utf8')).toContain('saved answer')
  const outcome = yield* Effect.exit(main([dir, '--output', output]))
  expect(outcome._tag).toBe('Failure')
  expect(readFileSync(join(dir, 'main.jsonl'), 'utf8')).toContain('saved answer')
})))


test("kernel commands show source with saved output without claiming full results", () => {
  const rows = parseSession(JSON.stringify({ role: "command", text: "kernel", args: { summary: "Read file", code: "export default 42" }, output: "tail only" }))
  const html = renderSession("/session/main.jsonl", rows)
  expect(html).toContain("export default 42")
  expect(html).toContain("tail only")
  expect(html).toContain("completeness not established")
  expect(html).toContain("not a kernel cell number")
})


test("compact timeline exposes timestamped context and cumulative usage on hover and focus", () => {
  const rows = parseSession([
    { role: "user", text: "start", ts: 1 },
    { role: "size", text: "800", ts: 10 },
    { role: "command", text: "kernel", args: { summary: "Inspect", code: "export default 1" }, ts: 20 },
  ].map(r => JSON.stringify(r)).join("\n"))
  const html = renderSession("/session/main.jsonl", rows, [], {
    note: "Fixture usage", samples: [
      { ts: 5, input: 800, output: 20, cached: 700, thinking: 5 },
      { ts: 15, input: 900, output: 30, cached: 600, thinking: 10 },
    ],
  })
  expect(html).toContain('aria-label="Session timeline"')
  expect(html).toContain('href="#event-3"')
  expect(html).toContain('role="slider"')
  expect(html).toContain('aria-describedby="minimap-tip"')
  expect(html).toContain('data-entries="')
  expect(html).toContain("Last request context: 800 tokens (snapshot 1970-01-01T00:00:00.010Z)")
  expect(html).toContain("Recorded input so far: 1,700 tokens")
  expect(html).toContain("Recorded output so far: 50 tokens")
  expect(html).toContain("Input + output: 1,750 tokens")
  expect(html).toContain("Cached input (subset): 1,300")
  expect(html).toContain("Reasoning output (subset): 15")
  expect(html).toContain("1 tool names observed")
  expect(html).toContain("Used during this session—not a list of tools available at startup")
  expect(html).not.toContain('<details open')
})

test("end counters include trailing calls without moving usage backwards onto earlier events", () => {
  const rows = parseSession(JSON.stringify({ role: "user", text: "hello", ts: 10 }))
  const html = renderSession("/session/main.jsonl", rows, [], {
    note: "Fixture", samples: [{ ts: 20, input: 123, output: 7 }],
  })
  expect(html).toContain("Recorded input so far: not recorded tokens")
  expect(html).toContain('<strong>123</strong><span>Recorded input · cumulative</span>')
  expect(html).toContain('<strong>130</strong><span>Input + output · cumulative</span>')
  expect(html).toContain("Cached input (subset): not recorded")
})

test("inventories stay collapsed and observed tool names remain escaped", () => {
  const rows = parseSession(JSON.stringify({ role: "command", text: '<img src=x onerror=alert(1)>', ts: 1 }))
  const html = renderSession("/session/main.jsonl", rows)
  expect(html).toContain('<details class="setup" id="setup">')
  expect(html).not.toContain('<img')
  expect(html).toContain("&lt;img")
  expect(html).toContain('max-height:180px')
  expect(html).toContain('@media(max-width:760px)')
  expect(html).toContain('read-only snapshot')
})
