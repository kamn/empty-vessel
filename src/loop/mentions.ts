import { statSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { Effect } from "effect"
import { Kernel } from "../tools/kernel-service"

// @path in a message: the user points at a file, as in OpenCode, Pi and Claude Code. Each one that is a file goes into
// System Two's first prompt this turn, beside what System One gathers; the message itself stays as typed (System One
// reads the request, not the files). Files System Two already has from an earlier turn aren't given again.
const MAX_FILES = 10
const MAX_CHARS = 100_000 // per file: a mention of a huge log shouldn't fill the context

// The mentioned paths that are files, relative to `root` when inside it, without trailing punctuation ("see @a.ts.").
export const mentionedFiles = (input: string, root: string) => {
  const found = new Set<string>()

  for (const [, raw] of input.matchAll(/(?:^|\s)@(\S+)/g)) {
    const path = raw!.replace(/[.,;:!?)\]'"`]+$/, "")
    const full = resolve(root, path)
    const isFile = (() => { try { return statSync(full).isFile() } catch { return false } })()
    if (!isFile) continue
    const inside = relative(root, full)
    found.add(inside.startsWith("..") || isAbsolute(inside) ? full : inside)
    if (found.size >= MAX_FILES) break
  }

  return [...found]
}

// The mentioned files not yet given to System Two, packed as gather packs its files; `given` is updated.
export const packMentioned = (input: string, root: string, given: Set<string>) =>
  Effect.gen(function* () {
    const { files } = yield* Kernel
    const fresh = mentionedFiles(input, root).filter((p) => !given.has(p))
    const packed: Array<string> = []

    for (const path of fresh) {
      const text = (yield* files.read(root, isAbsolute(path) ? relative(root, path) : path)) ?? ""
      if (text.includes("\0")) continue // binary: not for a prompt
      given.add(path)
      const cut = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[… cut at ${MAX_CHARS} of ${text.length} characters: read the rest if you need it]` : text
      packed.push(`<file path="${path}">\n${cut}\n</file>`)
    }

    return { paths: fresh.filter((p) => given.has(p)), packed: packed.join("\n\n") }
  })
