// One scanner for every skill: agent-written (saveSkill), installed and discovered (KTD21). Text patterns per file,
// never running anything. "dangerous" blocks a save or install; "warn" is shown and allowed.
// ponytail: regexes catch the common shapes (curl | sh, zero-width characters, "ignore previous instructions"), not
// an obfuscated payload; a real sandbox, not this, is what makes a hostile skill safe.

export type ScanKind = "download-and-run" | "credentials" | "hidden-unicode" | "prompt-injection" | "script"
export type ScanFlag = { readonly file: string; readonly kind: ScanKind; readonly severity: "warn" | "dangerous"; readonly detail: string }
export type Verdict = "ok" | "warn" | "dangerous"
export type Scan = { readonly verdict: Verdict; readonly flags: ReadonlyArray<ScanFlag> }

const PATTERNS: ReadonlyArray<readonly [ScanKind, "warn" | "dangerous", RegExp]> = [
  ["download-and-run", "dangerous", /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|<\(\s*(?:curl|wget)\b|\$\(\s*(?:curl|wget)\b/i],
  // Zero-width, bidi controls and Unicode tags: text the reader doesn't see but the model does.
  ["hidden-unicode", "dangerous", /[​‌‎‏‪-‮⁠-⁤⁦-⁩﻿\u{e0000}-\u{e007f}]/u],
  ["prompt-injection", "dangerous", /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier|your)\s+(?:instructions|prompts?|rules)\b|\bdo not tell the user\b|\byou are now in (?:developer|god|DAN) mode\b/i],
  ["credentials", "warn", /~\/\.ssh\b|~\/\.aws\b|\.aws\/credentials|\bid_(?:rsa|ed25519)\b|(?:^|[\s"'`/(])\.env\b|\bkeychain\b|security\s+find-(?:generic|internet)-password/i],
]

const codePoint = (ch: string) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`

export const scanSkill = (files: ReadonlyArray<{ readonly path: string; readonly text: string }>): Scan => {
  const flags: Array<ScanFlag> = []

  for (const { path, text } of files) {
    if (path === "scripts" || path.startsWith("scripts/")) flags.push({ file: path, kind: "script", severity: "warn", detail: "a script: never run by install or load, but the skill may tell the agent to run it" })

    for (const [kind, severity, pattern] of PATTERNS) {
      const found = pattern.exec(text)
      if (found) flags.push({ file: path, kind, severity, detail: kind === "hidden-unicode" ? `invisible character ${codePoint(found[0])}` : found[0].trim().slice(0, 120) })
    }
  }

  const verdict = flags.some((f) => f.severity === "dangerous") ? "dangerous" : flags.length ? "warn" : "ok"
  return { verdict, flags }
}

export const describeFlags = (flags: ReadonlyArray<ScanFlag>) => flags.map((f) => `${f.severity} ${f.kind} in ${f.file}: ${f.detail}`).join("; ")
