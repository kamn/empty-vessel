import { expect, test } from "bun:test"

// Keep the future core API mock isolated from every existing test's module cache.
for (const scenario of ["main", "wrapup", "structured", "absent", "models"]) {
  test(`Claude durable provider-result usage: ${scenario}`, async () => {
    const proc = Bun.spawn([process.execPath, new URL("./fixtures/usage-runner.ts", import.meta.url).pathname, scenario], {
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ])
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" })
    expect(stdout).toContain(`PASS ${scenario}`)
  }, 15_000)
}
