// Recover declarations from saved user-prompt envelopes, not current configuration or tool output.
type Row = { line: number; role: string; text: string; data?: Record<string, any> }
export type ContextSource = { name: string; tools: string[]; unavailable?: string; instructions?: string; firstLine: number; lastLine: number; sightings: number }
export type ContextEvidence = { sources: ContextSource[]; files: Array<{ name: string; line: number }>; handedTools: Array<{ name: string; line: number }> }
const sourceHeader = /^Tool sources \(outside tools, import from "kernel"; each tool takes one object of arguments; tools\(\) describes them\): (.+)$/m
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value)

export const recordedContext = (rows: ReadonlyArray<Row>): ContextEvidence => {
  const versions = new Map<string, ContextSource>()
  const files = new Map<string, number>()
  const handedTools = new Map<string, number>()

  for (const row of rows) {
    if (row.role === "given" && row.text && !files.has(row.text)) files.set(row.text, row.line)
    if (row.role === "tools" && row.text && !handedTools.has(row.text)) handedTools.set(row.text, row.line)
    const item = row.data?.item
    if (row.role !== "thread" || !object(item) || item.role !== "user") continue

    const content = typeof item.content === "string" ? item.content : Array.isArray(item.content)
      ? item.content.filter((part: unknown) => object(part) && part.type === "input_text" && typeof part.text === "string").map((part: { text: string }) => part.text).join("\n") : ""
    // Supplied files and fenced examples are not prompt-level tool declarations.
    const prompt = content.replace(/<file\b[^>]*>[\s\S]*?<\/file>/g, s => s.replace(/[^\n]/g, " ")).replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*(?:\n|$)/gm, s => s.replace(/[^\n]/g, " "))
    const header = sourceHeader.exec(prompt)
    if (!header) continue

    const rest = content.slice(header.index + header[0].length)
    const declarations = [...header[1]!.matchAll(/(?:^|; )([A-Za-z_][A-Za-z0-9_]*) \((.*?)\)(?=; |$)/g)]
    for (const declaration of declarations) {
      const name = declaration[1]!
      const value = declaration[2]!
      const unavailable = value.startsWith("not available:") ? value.slice("not available:".length).trim() : undefined
      const tools = unavailable !== undefined ? [] : value.split(", ").filter(t => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t))
      const marker = `${name}'s instructions (from the source itself):\n`
      const start = rest.indexOf(marker)
      const tail = start < 0 ? undefined : rest.slice(start + marker.length)
      // Stop at another source's instructions or a known harness section. Preserve the recorded text otherwise.
      const instructions = tail?.split(/\n\n(?=[A-Za-z_][A-Za-z0-9_]*'s instructions \(from the source itself\):|Helpers \(|Library tools \(|Tools on trial \(|Agents[: (]|Step \d+:|Prioritize skills over tools\.)/, 1)[0]?.trim() || undefined
      const key = JSON.stringify([name, tools, unavailable, instructions])
      const previous = versions.get(key)
      if (previous) { previous.lastLine = row.line; previous.sightings++; continue }
      versions.set(key, { name, tools, unavailable, instructions, firstLine: row.line, lastLine: row.line, sightings: 1 })
    }
  }

  return { sources: [...versions.values()], files: [...files].map(([name, line]) => ({ name, line })), handedTools: [...handedTools].map(([name, line]) => ({ name, line })) }
}
