import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { EMPTY_VESSEL_HOME } from "./home"

// Images in the user's message: a path to an image file (dragging a file into the terminal pastes its path, with
// spaces escaped as "\ " or the whole path in quotes; the TUI shows it as [Image #1]) is sent to System Two as the image
// itself, so the model can look at it. Only files that exist count; anything else stays text.

const EXT = /\.(png|jpe?g|gif|webp)$/i
const MAX_BYTES = 20_000_000
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }

export type ImageRef = { readonly label: string; readonly path: string }

// Candidate paths in the text: quoted ('…' or "…"), or unquoted with "\ " escapes, ending in an image extension.
// Unquoted ones lose trailing punctuation from the sentence around them ("look at a.png, then…").
const candidates = (text: string) => [...text.matchAll(/"([^"]+)"|'([^']+)'|((?:\\ |[^\s"'])+)/g)]
  .map((m) => {
    const quoted = m[1] ?? m[2]
    const raw = quoted !== undefined ? m[0] : m[3]!.replace(/[),.;:!?]+$/, "")
    return { raw, path: (quoted ?? raw).replace(/\\ /g, " ") }
  })
  .filter((c) => EXT.test(c.path))

// A picture on the clipboard (a screenshot, an image copied from a page), saved as a file under ~/.empty-vessel/pastes (it's
// kept: the session stores the path, and resuming reads it again). Its path, or undefined if the clipboard has no image.
// ponytail: macOS only (osascript), PNG only; a copied file (Finder) isn't read, add «class furl» if that's wanted.
export const clipboardImage = (dir = join(EMPTY_VESSEL_HOME, "pastes")) => {
  if (process.platform !== "darwin") return undefined
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.png`)

  const script = [`set f to open for access POSIX file "${path}" with write permission`, "write (the clipboard as «class PNGf») to f", "close access f"]
  const saved = Bun.spawnSync(["osascript", ...script.flatMap((line) => ["-e", line])], { stderr: "ignore" }).exitCode === 0 && existsSync(path) && statSync(path).size > 0

  if (!saved) rmSync(path, { force: true })
  return saved ? path : undefined
}

// The images in a message (files that exist and aren't too big), and the text with each shown as its label
// ("[Image #1]"), which is what System One and the thread's text see. `from`: the first label's number (the TUI's own count).
export const imagesIn = (text: string, cwd: string, from = 1) => {
  const images: Array<ImageRef> = []
  let labelled = text
  for (const c of candidates(text)) {
    const path = isAbsolute(c.path) ? c.path : resolve(cwd, c.path)
    if (images.some((i) => i.path === path) || !existsSync(path) || statSync(path).size > MAX_BYTES) continue
    const label = `[Image #${from + images.length}]`
    images.push({ label, path })
    labelled = labelled.replace(c.raw, label)
  }
  return { images, text: labelled }
}

// An image ready to send: its type and base64 bytes, shrunk to at most 1568 px on its longest side with macOS's sips
// when it's bigger (models see no more detail than that; smaller means cheaper, every request). Without sips: as is.
export const loadImage = (path: string) => {
  const ext = path.split(".").pop()!.toLowerCase()
  let bytes = readFileSync(path)
  const scratch = mkdtempSync(join(tmpdir(), "empty-vessel-image-"))
  try {
    const out = join(scratch, `small.${ext === "gif" ? "png" : ext}`)
    const shrunk = Bun.spawnSync(["sips", "-Z", "1568", path, "--out", out], { stdout: "ignore", stderr: "ignore" })
    if (shrunk.exitCode === 0 && existsSync(out) && statSync(out).size < bytes.length) bytes = readFileSync(out)
  } catch {} finally { rmSync(scratch, { recursive: true, force: true }) }
  return { mediaType: TYPES[ext === "gif" && bytes[0] === 0x89 ? "png" : ext] ?? "image/png", data: bytes.toString("base64") }
}

// Codex's image item for the thread: the image as a data URL, and its path as a hidden (non-enumerable) property, which
// JSON leaves out, so the API never sees it but the session can.
export const imageItem = (path: string) => {
  const img = loadImage(path)
  const item = { type: "input_image", image_url: `data:${img.mediaType};base64,${img.data}` }
  Object.defineProperty(item, "emptyVesselPath", { value: path, enumerable: false })
  return item
}

type Item = { content?: unknown }
const mapContent = (item: unknown, f: (part: any) => unknown) => {
  const c = (item as Item)?.content
  return Array.isArray(c) ? { ...(item as object), content: c.map(f) } : item
}

// For the session file: an image as its path, not its bytes (a screenshot is megabytes, in every save and snapshot).
export const toSaved = (item: unknown) => mapContent(item, (p) => (p?.type === "input_image" && p.emptyVesselPath ? { type: "input_image", emptyVesselPath: p.emptyVesselPath } : p))

// Back from the session file: the image read again from its path (or a note if it's gone).
export const fromSaved = (item: unknown) => mapContent(item, (p) =>
  p?.type === "input_image" && p.emptyVesselPath ? (existsSync(p.emptyVesselPath) ? imageItem(p.emptyVesselPath) : { type: "input_text", text: `[an image that's no longer there: ${p.emptyVesselPath}]` }) : p)
