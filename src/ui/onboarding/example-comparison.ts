// Illustrative only: every command, timing, token count, and result below is made up.
const event = (at: number, text: string, detail: string) => ({ at, text, detail })
export const EXAMPLE_COMPARISON = {
  title: "fix the retry bug in the uploader", speed: 8,
  baseline: { name: "System Two alone", wallMs: 60000, inputTokens: 42000, cachedInputTokens: 24000, passed: 6, failed: 0, events: [
    event(2000, "$ ls src", "Find the uploader module"),
    event(10000, "$ grep -R retry src", "Search for retry handling"),
    event(20000, "read uploader.ts", "Read the retry loop and its callers"),
    event(32000, "read uploader.test.ts", "Find tests for the retry limit"),
    event(44000, "✎ fix retry limit", "Stop after maxAttempts rather than trying once more"),
    event(52000, "$ bun test uploader", "Run the uploader tests"),
    event(58000, "✓ 6 tests passed", "Includes the retry-limit regression test"),
  ] },
  harness: { name: "empty-vessel", wallMs: 24000, inputTokens: 14000, cachedInputTokens: 8000, passed: 6, failed: 0, events: [
    event(0, "● System One gathers", "Find the uploader and its tests"),
    event(2000, "✓ uploader.ts + tests", "Gather selects two relevant files"),
    event(3000, "→ System Two gets 2 files", "Hand off the retry loop and test context"),
    event(14000, "✎ fix retry limit", "Stop after maxAttempts rather than trying once more"),
    event(19000, "$ bun test uploader", "System One runs the same uploader tests"),
    event(22000, "✓ 6 tests passed", "Includes the retry-limit regression test"),
  ] },
} as const
