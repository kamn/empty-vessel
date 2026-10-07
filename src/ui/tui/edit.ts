// Editing the input box: the text and where the cursor is, as `after` (how many characters are after the cursor: 0 is
// the end, so text that's replaced whole, a recalled message or a restored queue, has its cursor at the end).
// Characters are code points (an emoji is one), so the cursor never lands inside one.

export type Draft = { readonly input: string; readonly after: number }

const chars = (s: string) => Array.from(s)
const split = (d: Draft) => {
  const all = chars(d.input)
  const at = Math.max(0, all.length - Math.min(d.after, all.length))
  return { before: all.slice(0, at), rest: all.slice(at) }
}
const join = (before: ReadonlyArray<string>, rest: ReadonlyArray<string>): Draft => ({ input: [...before, ...rest].join(""), after: rest.length })

export const insert = (d: Draft, text: string) => { const { before, rest } = split(d); return join([...before, ...chars(text)], rest) }

const LABEL = /\[(?:Image|Text) #\d+\]$/
// Backspace: the character before the cursor, or a whole image/text label that ends there.
export const backspace = (d: Draft) => {
  const { before, rest } = split(d)
  const label = before.join("").match(LABEL)
  return join(before.slice(0, label ? -chars(label[0]).length : -1), rest)
}
export const deleteAfter = (d: Draft) => { const { before, rest } = split(d); return join(before, rest.slice(1)) }

export const left = (d: Draft) => ({ ...d, after: Math.min(chars(d.input).length, d.after + 1) })
export const right = (d: Draft) => ({ ...d, after: Math.max(0, d.after - 1) })

// A word: letters, digits and _; skip what isn't one, then the word itself.
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c)
export const wordLeft = (d: Draft) => {
  const { before } = split(d)
  let i = before.length
  while (i > 0 && !isWord(before[i - 1])) i--
  while (i > 0 && isWord(before[i - 1])) i--
  return { ...d, after: chars(d.input).length - i }
}
export const wordRight = (d: Draft) => {
  const { before, rest } = split(d)
  let i = 0
  while (i < rest.length && !isWord(rest[i])) i++
  while (i < rest.length && isWord(rest[i])) i++
  return { ...d, after: rest.length - i }
}
// Ctrl+W: the word before the cursor (and the spaces after it).
export const deleteWord = (d: Draft) => { const moved = wordLeft(d); const at = chars(d.input).length - moved.after; const { before, rest } = split(d); return join(before.slice(0, at), rest) }

// The cursor's line: where it starts and ends (as positions in the text), and the cursor's column in it.
const lineAt = (d: Draft) => {
  const all = chars(d.input)
  const at = all.length - Math.min(d.after, all.length)
  let start = at
  while (start > 0 && all[start - 1] !== "\n") start--
  let end = at
  while (end < all.length && all[end] !== "\n") end++
  return { all, at, start, end, col: at - start }
}
export const home = (d: Draft) => { const l = lineAt(d); return { ...d, after: l.all.length - l.start } }
export const end = (d: Draft) => { const l = lineAt(d); return { ...d, after: l.all.length - l.end } }
// Ctrl+K: the rest of the line (or, at its end, the line break).
export const deleteToEnd = (d: Draft) => {
  const l = lineAt(d)
  return join(l.all.slice(0, l.at), l.all.slice(l.end === l.at ? l.end + 1 : l.end))
}

// Up / Down inside a draft of several lines: the same column on the line above or below. Undefined on the first line
// (Up) or the last (Down): then the key recalls earlier messages instead.
export const lineUp = (d: Draft): Draft | undefined => {
  const l = lineAt(d)
  if (l.start === 0) return undefined
  let prevStart = l.start - 1
  while (prevStart > 0 && l.all[prevStart - 1] !== "\n") prevStart--
  return { ...d, after: l.all.length - Math.min(prevStart + l.col, l.start - 1) }
}
export const lineDown = (d: Draft): Draft | undefined => {
  const l = lineAt(d)
  if (l.end === l.all.length) return undefined
  let nextEnd = l.end + 1
  while (nextEnd < l.all.length && l.all[nextEnd] !== "\n") nextEnd++
  return { ...d, after: l.all.length - Math.min(l.end + 1 + l.col, nextEnd) }
}

// The text before the cursor (to draw it where it is).
export const beforeCursor = (d: Draft) => split(d).before.join("")
