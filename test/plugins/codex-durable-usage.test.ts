import { expect, test } from "bun:test"

// Isolate module mocks so other provider tests retain the real fs exports.
test("Codex durable usage with mocked credentials, HTTP and session persistence", async () => {
  const proc = Bun.spawn([process.execPath, "test", "./test/fixtures/codex-durable-usage.case.ts"], {
    cwd: process.cwd(), env: { ...process.env, CODEX_DURABLE_TEST: "1" }, stdout: "pipe", stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  expect(out + err).toMatch(/\b6 pass\b/)
  expect(out + err).not.toMatch(/\b[1-9]\d* fail\b/)
  expect(code).toBe(0)
}, 30_000)
