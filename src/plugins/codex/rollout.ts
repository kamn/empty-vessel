import { appendFile, mkdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { withLock, type SessionEntry } from "empty-vessel"

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const codexRolloutIdentity = (key: string) => {
  const [root, ...ids] = key.split("/")
  if (root !== "sessions" || !ids.length || !ids.every((id) => uuidV7.test(id))) {
    throw new Error("Invalid Codex rollout session key")
  }

  const id = ids.at(-1)!.toLowerCase()
  const start = new Date(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toISOString()
  const home = process.env.CODEX_HOME || join(homedir(), ".codex")
  const path = join(home, "sessions", ...start.slice(0, 10).split("-"),
    `rollout-empty-vessel-${start.replaceAll(":", "-")}-${id}.jsonl`)
  return { id, parent: ids.at(-2)?.toLowerCase(), start, path }
}
type Row = { timestamp: string; type: string; payload: Readonly<Record<string, unknown>> }
const row = (timestamp: string, type: string, payload: Row["payload"]): Row => ({ timestamp, type, payload })
const safely = (work: Effect.Effect<void>) => work.pipe(
  Effect.catchCause(() => Effect.logWarning("Codex rollout export failed; agent continues")),
)

const append = (key: string, rows: ReadonlyArray<Row>): Effect.Effect<void> => Effect.suspend(() => {
  const { id, parent, path } = codexRolloutIdentity(key)
  // Our children do not replay parent history. Codex fork metadata makes AgentPlayback
  // discard their real usage as a replay; keep ancestry in a empty-vessel-only field instead.
  const ancestry = parent ? { empty_vessel_parent_session_id: parent } : {}

  return withLock(path, Effect.promise(async () => {
    await mkdir(dirname(path), { recursive: true })
    const size = await stat(path).then((s) => s.size, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0
      throw error
    })
    const meta = row(new Date().toISOString(), "session_meta", {
      id, cwd: process.cwd(), originator: "empty-vessel", source: "cli", ...ancestry,
    })
    const batch = size === 0 ? [meta, ...rows] : rows
    await appendFile(path, batch.map((item) => JSON.stringify(item)).join("\n") + "\n", { mode: 0o600 })
  }))
})

export const codexSessionMirror = (entry: SessionEntry): Effect.Effect<void> => safely(Effect.suspend(() => {
  const { key, role, text, ts } = entry
  if (!["user", "steer", "assistant", "step", "command", "check"].includes(role)) return Effect.void
  const timestamp = new Date(ts).toISOString()

  if (role === "user" || role === "steer") {
    return append(key, [row(timestamp, "event_msg", { type: "user_message", message: text, images: [] })])
  }

  if (role === "assistant") {
    return append(key, [
      row(timestamp, "event_msg", { type: "agent_message", message: text }),
      row(timestamp, "event_msg", { type: "task_complete", last_agent_message: text }),
    ])
  }

  return append(key, [row(timestamp, "response_item", {
    type: "reasoning", summary: [{ type: "summary_text", text: `empty-vessel activity: ${role}` }],
  })])
}))


// AgentPlayback globally deduplicates equal usage at the same millisecond. Reserve
// distinct recording times for parallel requests in this process (not cumulative counts).
let lastUsageTime = 0, lastWallTime = 0
const usageTimestamp = () => {
  const wall = Date.now()
  lastUsageTime = wall < lastWallTime ? wall : Math.max(wall, lastUsageTime + 1)
  lastWallTime = wall
  return new Date(lastUsageTime).toISOString()
}

export const recordCodexUsage = (
  key: string, model: string,
  usage: { input: number; cached?: number; output: number; thinking?: number },
  usageId?: string,
): Effect.Effect<void> => safely(Effect.suspend(() => {
  const timestamp = usageTimestamp()
  const last_token_usage = {
    input_tokens: usage.input, cached_input_tokens: usage.cached ?? 0,
    output_tokens: usage.output, reasoning_output_tokens: usage.thinking ?? 0,
    total_tokens: usage.input + usage.output,
  }

  return append(key, [
    row(timestamp, "turn_context", { model }),
    row(timestamp, "event_msg", { type: "token_count", ...(usageId === undefined ? {} : { usage_id: usageId }), info: { last_token_usage } }),
  ])
}))
