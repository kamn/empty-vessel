// Command parsing is deliberately not shell evaluation: quotes group a path, but variables,
// command substitutions and glob characters remain literal. The destination scope is explicit.
export type ImportRoute =
  | { readonly kind: "import"; readonly path: string; readonly scope: "project" | "personal" }
  | { readonly kind: "error"; readonly message: string }
const usage = "Usage: /skills import <folder> --scope project|personal (quote paths containing spaces). Existing skills are never overwritten."

export const parseSkillImport = (text: string): ImportRoute => {
  const tokens: string[] = []
  let token = "", quote = "", started = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!

    if (char === "\\" && quote !== "'") {
      const next = text[++i]
      if (next === undefined) return { kind: "error", message: usage }
      token += next
      started = true
    } else if (quote) {
      if (char === quote) quote = ""
      else token += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token)
      token = ""
      started = false
    } else {
      token += char
      started = true
    }
  }

  if (quote) return { kind: "error", message: `Unclosed quote. ${usage}` }
  if (started) tokens.push(token)
  const scope = tokens.length === 3 && tokens[1] === "--scope" ? tokens[2]
    : tokens.length === 2 && tokens[1]!.startsWith("--scope=") ? tokens[1]!.slice("--scope=".length)
    : undefined
  if (!tokens[0] || (scope !== "project" && scope !== "personal")) return { kind: "error", message: usage }
  return { kind: "import", path: tokens[0], scope }
}
