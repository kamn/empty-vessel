import { expect, test } from "bun:test"
import { recordedContext } from "../scripts/session-notebook-context"
import { parseSession, renderSession } from "../scripts/session-notebook"

const header = 'Tool sources (outside tools, import from "kernel"; each tool takes one object of arguments; tools() describes them): '
const declaration = header + 'posthog (exec)\n\nposthog\'s instructions (from the source itself):\nUse exec.\n\n```ts\nposthog.exec({ command: "example" })\n```\n\nPrioritize skills over tools.'
const row = (line: number, content: unknown, role = "user") => ({ line, role: "thread", text: "", data: { item: { role, content } } })

test("recovers tool declarations and original instructions, not just executed tools", () => {
  const context = recordedContext([row(3, [{ type: "input_text", text: 'Goal: inspect\n\n' + declaration }])])
  expect(context.sources).toHaveLength(1)
  expect(context.sources[0]).toMatchObject({ name: "posthog", tools: ["exec"], firstLine: 3, lastLine: 3, sightings: 1 })
  expect(context.sources[0]!.instructions).toContain('posthog.exec({ command: "example" })')
  expect(context.sources[0]!.instructions).not.toContain('Prioritize skills')
})

test("tracks repeated declarations and changed tool availability with provenance", () => {
  const context = recordedContext([row(3, declaration), row(9, declaration), row(12, header + 'posthog (exec, new_tool); other (not available: offline)')])
  expect(context.sources).toHaveLength(3)
  expect(context.sources[0]).toMatchObject({ firstLine: 3, lastLine: 9, sightings: 2 })
  expect(context.sources[1]!.tools).toEqual(['exec', 'new_tool'])
  expect(context.sources[2]).toMatchObject({ name: 'other', tools: [], unavailable: 'offline' })
})

test("does not mistake supplied files, fenced examples, assistant text or tool output for loaded context", () => {
  const context = recordedContext([
    row(1, `<file path="example.ts">\n${declaration}\n</file>`),
    row(2, '~~~text\n' + header + 'fake (run)\n~~~'),
    row(3, declaration, 'assistant'),
    { line: 4, role: 'command', text: declaration },
    { line: 5, role: 'thread', text: '', data: { item: { type: 'function_call_output', output: declaration } } },
  ])
  expect(context.sources).toEqual([])
})

test("masking file examples preserves offsets into actual source instructions", () => {
  const context = recordedContext([row(8, '<file path="example.ts">\n' + header + 'fake (call)\n</file>\n\n' + declaration)])
  expect(context.sources.map(s => s.name)).toEqual(['posthog'])
  expect(context.sources[0]!.instructions).toStartWith('Use exec.')
})

test("source instructions stop at the next source or harness section", () => {
  const context = recordedContext([row(7, header + "one (run); two (list)\n\none's instructions (from the source itself):\nFirst instructions.\n\ntwo's instructions (from the source itself):\nSecond instructions.\n\nStep 1: private unrelated step")])
  expect(context.sources.map(s => s.instructions)).toEqual(['First instructions.', 'Second instructions.'])
})

test("given files and library handoffs are separate evidence, not full startup manifests", () => {
  const context = recordedContext([
    { line: 1, role: 'given', text: 'a.ts' }, { line: 2, role: 'given', text: 'a.ts' },
    { line: 3, role: 'tools', text: 'helper' }, { line: 4, role: 'shown', text: 'candidate' },
  ])
  expect(context.files).toEqual([{ name: 'a.ts', line: 1 }])
  expect(context.handedTools).toEqual([{ name: 'helper', line: 3 }])
  expect(context.sources).toEqual([])
})

test("real rendering distinguishes supplied context, usage, and unknown skills while escaping instructions", () => {
  const saved = JSON.stringify({ role: 'thread', text: '', item: { role: 'user', content: declaration + '\n<script>alert(1)</script>' }, ts: 1 })
  const rows = parseSession(saved)
  const html = renderSession('/session/main.jsonl', rows, [], { samples: [{ ts: 1, model: '<fake-model>', input: 10, output: 2, cached: 0, thinking: 0 }], note: 'fixture' })
  expect(html).toContain('in saved context: posthog.exec')
  expect(html).toContain('Instructions loaded into the saved prompt')
  expect(html).toContain('href="#event-1"')
  expect(html).toContain('Recorded usage by model')
  expect(html).toContain('&lt;fake-model&gt;')
  expect(html).not.toContain('<script>')
  expect(html).toContain('do not establish that a skill was loaded')
  expect(html.indexOf('id="model-heading"')).toBeLessThan(html.indexOf('<section class="event'))
})
