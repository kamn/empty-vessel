import { Effect, Layer } from "effect"
import { ActionGuard, type GuardVerdict, type Plugin } from "empty-vessel"

type Word = { text: string; dynamic: boolean; syntax?: true }
const allow: GuardVerdict = { decision: "allow" }
const revise = (): GuardVerdict => ({ decision: "revise", reason: "Use simple commands and explicit literal relative rm paths; expansions, redirections and indirect invocation are not supported." })

// Deliberately NOT a shell parser or sandbox. Recognizes words, shell quoting/escaping,
// comments and && || ; newline |. Unsupported syntax requests revision even on non-rm
// commands (notably redirects and substitutions, which can execute hidden commands).
// No alias/function/PATH resolution, filesystem checks, symlink checks or protection
// against other deletion programs. Relative ../ paths are intentionally allowed.
const tokenize = (source: string): { commands: Word[][]; unsupported: boolean } => {
  const commands: Word[][] = [[]]
  let text = "", active = false, dynamic = false, quote = "", unsupported = false
  const flush = () => {
    if (active) commands[commands.length - 1]!.push({ text, dynamic })
    text = ""; active = false; dynamic = false
  }

  for (let i = 0; i < source.length; i++) {
    const c = source[i]!

    if (c === "\\" && quote !== "'") {
      const next = source[++i]
      if (next === undefined) { unsupported = true; break }
      if (next === "\n") continue
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) text += "\\"
      text += next; active = true
      continue
    }

    if (quote) {
      if (c === quote) quote = ""
      else {
        text += c
        if (quote === '"' && (c === "$" || c === "`")) dynamic = unsupported = true
      }
      continue
    }

    if (c === "'" || c === '"') { quote = c; active = true; continue }
    if (c === "#" && !active) {
      while (i + 1 < source.length && source[i + 1] !== "\n") i++
      continue
    }
    if (c === " " || c === "\t" || c === "\r") { flush(); continue }
    if (";&|\n".includes(c)) {
      flush()
      if ((c === "&" || c === "|") && source[i + 1] === c) i++
      else if (c === "&") unsupported = true
      commands.push([])
      continue
    }

    if ("$`~{}*?[]".includes(c)) dynamic = unsupported = true
    if ("<>()".includes(c)) {
      flush()
      unsupported = true
      commands[commands.length - 1]!.push({ text: c, dynamic: true, syntax: true })
      continue
    }
    text += c; active = true
  }

  flush()
  return { commands, unsupported: unsupported || quote !== "" }
}

const assignment = (word: Word) => /^[A-Za-z_][A-Za-z_0-9]*=/.test(word.text) && !word.dynamic
// A command's name, without its folder and in lower case: macOS's disk usually ignores case, so RM and /BIN/RM run rm.
const base = (text: string) => text.slice(text.lastIndexOf("/") + 1).toLowerCase()
// Shells and launchers that run a command given as a string: wherever one appears (nice sh -c, timeout 5 bash -c,
// su root -c, find -exec sh -c), its rm isn't a word this policy can see.
// (exec, source and . only count first: later, `docker exec` or a "." argument are ordinary.)
const SHELLS = ["sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh", "su", "eval", "xargs"]

const checkCommand = (words: Word[]): GuardVerdict => {
  let i = 0
  while (words[i] && assignment(words[i]!)) i++

  // Only these explicit wrapper forms are understood. No shell strings or arbitrary
  // option arguments. Unknown forms revise rather than guessing where rm starts.
  while (words[i] && ["sudo", "command", "env"].includes(base(words[i]!.text))) {
    const wrapper = words[i++]!
    const name = base(wrapper.text)
    if (wrapper.dynamic || (wrapper.text !== name && wrapper.text !== `/usr/bin/${name}` && wrapper.text !== `/bin/${name}`)) return revise()

    while (words[i]) {
      const word = words[i]!
      if (word.dynamic) return revise()
      if (word.text === "--") { i++; break }
      if (name === "env" && assignment(word)) { i++; continue }
      if (!word.text.startsWith("-")) break
      if ((name === "sudo" && ["-n", "-E", "-H"].includes(word.text)) || (name === "command" && word.text === "-p") || (name === "env" && word.text === "-i")) { i++; continue }
      if (name === "sudo" && ["-u", "-g"].includes(word.text) && words[i + 1] && !words[i + 1]!.dynamic && /^[A-Za-z_0-9-]+$/.test(words[i + 1]!.text)) { i += 2; continue }
      return revise()
    }
  }

  const executable = words[i++]
  if (!executable) return allow
  if (executable.dynamic) return revise()

  const path = executable.text.toLowerCase()
  if (path !== "rm" && path !== "/bin/rm" && path !== "/usr/bin/rm") {
    // Known interpreters/control syntax and rm passed through unknown launchers.
    // Literal echo/printf arguments aren't commands.
    if (["echo", "printf", "cat"].includes(base(executable.text))) return allow
    if (base(executable.text) === "rm" || [...SHELLS, "exec", "source", ".", "if", "then", "else", "for", "while", "until", "do", "case", "function", "!"].includes(base(executable.text)) || words.slice(i).some((w) => base(w.text) === "rm" || SHELLS.includes(base(w.text)))) return revise()
    return allow
  }

  let options = true, uncertain = false

  for (const word of words.slice(i)) {
    if (word.syntax) return revise()
    if (options && word.text === "--") { options = false; continue }
    if (options && word.text.startsWith("-") && word.text !== "-") {
      // Unknown options may consume operands; don't try to interpret their values.
      if (word.dynamic || !(/^-[firdvIRPW]+$/.test(word.text) || ["--force", "--recursive", "--dir", "--verbose", "--interactive", "--preserve-root", "--no-preserve-root", "--one-file-system", "--help", "--version"].includes(word.text))) uncertain = true
      continue
    }
    if (word.text.startsWith("/")) return { decision: "deny", reason: `Absolute rm target is forbidden: ${word.text}. Use explicit literal relative paths.` }
    if (word.dynamic) uncertain = true
  }

  return uncertain ? revise() : allow
}

/** Pure syntactic policy: deny beats revise across all recognized subcommands. */
export const noAbsoluteRmPolicy = (command: string): GuardVerdict => {
  const parsed = tokenize(command)
  let verdict = parsed.unsupported ? revise() : allow

  for (const words of parsed.commands) {
    const next = checkCommand(words)
    if (next.decision === "deny") return next
    if (next.decision === "revise") verdict = next
  }

  return verdict
}

export const noAbsoluteRm = {
  name: "no-absolute-rm",
  provides: {
    actionGuard: Effect.succeed(Layer.succeed(ActionGuard, {
      beforeAction: (action) => Effect.succeed(noAbsoluteRmPolicy(action.command)),
    })),
  },
} satisfies Plugin
