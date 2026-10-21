// A desktop notification when a long turn ends, so you can look away while it works (as OpenCode and Claude Code do):
// OSC 9, which iTerm2, Ghostty, WezTerm and others show; a terminal that doesn't know it ignores it.
export const NOTIFY_AFTER_MS = 30_000

// The escape to write after a turn that took `ms`, or "" for a quick one: the reply's first line, without control characters.
export const turnNotice = (ms: number, reply: string) => {
  if (ms < NOTIFY_AFTER_MS) return ""
  const line = reply.split("\n").find((l) => l.trim())?.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, "").trim() ?? ""
  const minutes = Math.floor(ms / 60_000), seconds = Math.round((ms % 60_000) / 1000)
  const took = minutes ? `${minutes}m ${seconds}s` : `${seconds}s`
  return `\x1b]9;empty-vessel finished (${took})${line ? `: ${line.slice(0, 100)}` : ""}\x07`
}
