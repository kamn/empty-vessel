import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { makeKernel } from "../src/kernel/kernel"

const output = process.argv[2]!
const dir = mkdtempSync(join(tmpdir(), "empty-vessel-worker-cost-"))
const root = new URL(import.meta.resolve("effect")).pathname
const direct = new URL(import.meta.resolve("effect/Effect")).pathname
const sources = {
  emptyWorker: 'self.onmessage = () => self.postMessage(1)',
  effectRootWorker: `import { Effect } from ${JSON.stringify(root)}; self.onmessage = () => self.postMessage(Effect.runSync(Effect.succeed(1)))`,
  effectDirectWorker: `import * as Effect from ${JSON.stringify(direct)}; self.onmessage = () => self.postMessage(Effect.runSync(Effect.succeed(1)))`,
}
const worker = (file: string) => new Promise<void>((resolve, reject) => {
  const w = new Worker(file)
  const timer = setTimeout(() => { w.terminate(); reject(new Error("benchmark Worker timed out")) }, 5000)
  w.onmessage = () => { clearTimeout(timer); w.terminate(); resolve() }
  w.onerror = e => { clearTimeout(timer); w.terminate(); reject(new Error(e.message)) }
  w.postMessage("go")
})
const stats = (samples: number[]) => {
  const ordered = samples.toSorted((a, b) => a - b)
  return { runs: samples.length, meanMs: samples.reduce((a, b) => a + b, 0) / samples.length, medianMs: ordered[Math.floor(ordered.length / 2)], minMs: ordered[0], maxMs: ordered.at(-1) }
}
try {
  for (const [name, code] of Object.entries(sources)) writeFileSync(join(dir, `${name}.ts`), code)
  const k = makeKernel({ dir: join(dir, "kernel"), spareWorker: false, languageServer: false })
  const cases: Record<string, () => Promise<unknown>> = Object.fromEntries(Object.keys(sources).map(name => [name, () => worker(join(dir, `${name}.ts`))]))
  cases.kernelNoTypesValue = async () => {
    const result = await Effect.runPromise(k.run("export default 1"))
    if (result.status !== "ok" || result.value !== 1) throw new Error(JSON.stringify(result))
  }
  cases.kernelNoTypesEffect = async () => {
    const result = await Effect.runPromise(k.run('import { Effect } from "kernel"\nexport default Effect.succeed(1)'))
    if (result.status !== "ok" || result.value !== 1) throw new Error(JSON.stringify(result))
  }
  const samples: Record<string, number[]> = Object.fromEntries(Object.keys(cases).map(name => [name, []]))
  for (let round = -3; round < 25; round++) {
    for (const [name, run] of Object.entries(cases)) {
      const start = performance.now()
      await run()
      if (round >= 0) samples[name]!.push(performance.now() - start)
    }
  }
  const start = performance.now()
  for (let i = 0; i < 10000; i++) await Effect.runPromise(Effect.succeed(1))
  const result = { bun: Bun.version, note: "Sequential round-robin; 3 warmups excluded; no TypeScript checking in kernel cases", cases: Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, stats(values)])), tenThousandInProcessEffectsMs: performance.now() - start }
  await Bun.write(output, JSON.stringify(result, null, 2) + "\n")
  console.log(JSON.stringify(result, null, 2))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
