// What a kernel's cells may use (config.json's kernel.tools). Each built-in
// needs one of these; a kernel grants some. Granted only ever narrows: a sub-agent gets its parent's, or less.

export type Grants = {
  readonly files: "read-write" | "read-only" | "none"
  readonly shell: boolean
  readonly systemOne: boolean
  readonly agents: boolean
  readonly library: boolean
  readonly sources: boolean
}
export const ALL: Grants = { files: "read-write", shell: true, systemOne: true, agents: true, library: true, sources: true }

export type Need = "read" | "write" | "shell" | "systemOne" | "agents" | "library" | "sources"
export const has = (g: Grants, need: Need) =>
  need === "read" ? g.files !== "none" : need === "write" ? g.files === "read-write" : g[need]
// What each of the kernel's built-ins needs (src/tools/kernel-builtins.ts): a kernel's built-ins module exports only the
// granted ones (src/loop/library.ts), so a cell importing another fails the type check before it runs. Unlisted
// exports (now, random, remember, forget, layer, types) need nothing.
export const NEEDS: Readonly<Record<string, Need>> = {
  read: "read", readText: "read", skill: "read", Files: "read", write: "write", edit: "write",
  bash: "shell", Shell: "shell",
  systemOne: "systemOne", judge: "systemOne", SystemOne: "systemOne",
  spawn: "agents", wait: "agents", cancel: "agents", jobs: "agents", Agents: "agents",
  promote: "library", tools: "library", handTools: "library", memory: "library", Library: "library",
}
export const allows = (g: Grants, name: string) => !NEEDS[name] || has(g, NEEDS[name]!)

export const allGranted =(g: Grants) => (["read", "write", "shell", "systemOne", "agents", "library", "sources"] as const).every((n) => has(g, n))

// A child's grants: what it asks for (names of needs, or a Grants-shaped object), never more than its parent's.
export const narrow = (parent: Grants, wanted: Partial<Grants> | undefined): Grants => {
  if (!wanted) return parent
  const files = (["none", "read-only", "read-write"] as const)
  const rank = (f: Grants["files"]) => Math.max(0, files.indexOf(f)) // a value that isn't one is none: never more
  const pick = (k: "shell" | "systemOne" | "agents" | "library" | "sources") => parent[k] && (wanted[k] ?? parent[k]) === true
  return {
    files: files[Math.min(rank(parent.files), rank(wanted.files ?? parent.files))]!,
    shell: pick("shell"), systemOne: pick("systemOne"), agents: pick("agents"), library: pick("library"), sources: pick("sources"),
  }
}

// Shell on with files read-only (or none) isn't that without a sandbox: bash can read and write anywhere it can reach.
// Warned, not refused: the setting still keeps write and edit out of the cells, and a sandbox would enforce the rest.
export const grantWarnings = (g: Grants) =>
  g.shell && g.files !== "read-write"
    ? [`⚠ kernel.tools: files are ${g.files === "none" ? "off" : "read-only"}, but the shell is on: without a sandbox, bash can still ${g.files === "none" ? "read and write" : "write"} files. Turn shell off for that to hold.`]
    : []
