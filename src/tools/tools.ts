import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Effect, Schema } from "effect"
import { BASH_TIMEOUT_SECONDS, MAX_BYTES, MAX_LINES, runBash } from "./bash"
import { jsonSchemaFor } from "../base/json-schema"

// A tool System Two can call: a name, a description the model reads, the JSON schema of its arguments,
// and `call`, which checks the model's arguments against the tool's Schema and then runs it.
// Tools never fail: every problem comes back as text the model can read and react to.
interface Tool {
  readonly name: string
  readonly description: string
  readonly jsonSchema: object
  readonly call: (args: unknown) => Effect.Effect<string>
}

const defineTool = <S extends Schema.Top & { readonly DecodingServices: never }>(
  name: string,
  description: string,
  schema: S,
  run: (args: S["Type"]) => Effect.Effect<string>,
): Tool => ({
  name,
  description,
  jsonSchema: jsonSchemaFor(schema),
  call: (args) =>
    Schema.decodeUnknownEffect(schema)(args).pipe(
      Effect.matchEffect({ onFailure: (e) => Effect.succeed(`invalid arguments for ${name}: ${e.message}`), onSuccess: run }),
    ),
})

const bashTool = defineTool(
  "bash",
  "Run a shell command in the project folder. Returns the exit code and output. Output is truncated to the last 2000 lines " +
    "or 50KB (whichever is hit first); if truncated, the full output is saved to a temp file and its path is given.",
  Schema.Struct({
    command: Schema.String.annotate({ description: "Shell command to run" }),
    timeout: Schema.optionalKey(Schema.Finite.annotate({ description: `Timeout in seconds (default ${BASH_TIMEOUT_SECONDS})` })),
  }),
  ({ command, timeout }) => runBash(command, (timeout ?? BASH_TIMEOUT_SECONDS) * 1000),
)

// Lines `offset`… of a file, within `limit` and the 2000-line / 50KB caps; says where to continue if there's more.
export const readLines = (text: string, offset: number, limit = MAX_LINES) => {
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop() // a final newline ends the last line; it doesn't start a new one
  if (offset > lines.length) return `offset ${offset} is past the end of the file (${lines.length} lines)`

  const shown: Array<string> = []
  let bytes = 0
  for (const line of lines.slice(offset - 1, offset - 1 + Math.min(limit, MAX_LINES))) {
    bytes += Buffer.byteLength(line) + 1
    if (bytes > MAX_BYTES && shown.length > 0) break
    shown.push(line)
  }

  const last = offset - 1 + shown.length
  return last < lines.length ? `${shown.join("\n")}\n\n[Showing lines ${offset}-${last} of ${lines.length}. Use offset=${last + 1} to continue.]` : shown.join("\n")
}

const readTool = defineTool(
  "read",
  "Read a text file. Output is truncated to 2000 lines or 50KB (whichever is hit first). " +
    "Use offset/limit for large files. When you need the full file, continue with offset until complete.",
  Schema.Struct({
    path: Schema.String.annotate({ description: "Path to the file to read (relative or absolute)" }),
    offset: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))).annotate({ description: "Line number to start reading from (1-indexed)" })),
    limit: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))).annotate({ description: "Maximum number of lines to read" })),
  }),
  ({ path, offset = 1, limit }) =>
    Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (e) => e }).pipe(
      Effect.map((text) => readLines(text, offset, limit)),
      Effect.catch((e) => Effect.succeed(`could not read ${path}: ${e instanceof Error ? e.message : String(e)}`)),
    ),
)

// "3 lines": a final newline ends the last line rather than starting a new one (same rule as readLines).
const countLines = (text: string) => {
  const n = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
  return `${n} line${n === 1 ? "" : "s"}`
}

const writeTool = defineTool(
  "write",
  "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
  Schema.Struct({
    path: Schema.String.annotate({ description: "Path to the file to write (relative or absolute)" }),
    content: Schema.String.annotate({ description: "Content to write to the file" }),
  }),
  ({ path, content }) =>
    Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, content)), catch: (e) => e }).pipe(
      Effect.as(`Successfully wrote to ${path} (${countLines(content)}, ${Buffer.byteLength(content)} bytes)`),
      Effect.catch((e) => Effect.succeed(`could not write ${path}: ${e instanceof Error ? e.message : String(e)}`)),
    ),
)

// Apply exact-text edits to the ORIGINAL text (not one after another): every oldText must appear exactly once,
// and no two may overlap. Returns the new text and each edit's line, or an error saying how to fix the call.
export const applyEdits = (text: string, path: string, edits: ReadonlyArray<{ oldText: string; newText: string }>) => {
  const spans: Array<{ i: number; start: number; end: number; newText: string }> = []
  for (const [i, { oldText, newText }] of edits.entries()) {
    if (oldText === "") return { error: `edits[${i}].oldText is empty. Give the exact text to replace (to create a file, use write).` }
    const count = text.split(oldText).length - 1
    if (count === 0) return { error: `edits[${i}].oldText was not found in ${path}. It must match the file exactly, including whitespace and indentation.` }
    if (count > 1) return { error: `edits[${i}].oldText occurs ${count} times in ${path}. It must be unique: include more surrounding lines.` }
    const start = text.indexOf(oldText)
    spans.push({ i, start, end: start + oldText.length, newText })
  }

  spans.sort((a, b) => a.start - b.start)
  for (let k = 1; k < spans.length; k++)
    if (spans[k]!.start < spans[k - 1]!.end) return { error: `edits[${spans[k - 1]!.i}] and edits[${spans[k]!.i}] overlap in ${path}. Merge them into one edit or target separate regions.` }

  let result = text
  for (const { start, end, newText } of [...spans].reverse()) result = result.slice(0, start) + newText + result.slice(end) // back to front: earlier positions stay valid
  return { result, lines: spans.map(({ start }) => text.slice(0, start).split("\n").length) }
}

const editTool = defineTool(
  "edit",
  "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. " +
    "If two changes affect the same block or nearby lines, merge them into one edit. Do not include large unchanged regions just to connect distant changes.",
  Schema.Struct({
    path: Schema.String.annotate({ description: "Path to the file to edit (relative or absolute)" }),
    edits: Schema.Array(
      Schema.Struct({
        oldText: Schema.String.annotate({ description: "Exact text to replace. Must be unique in the original file and not overlap any other edit." }),
        newText: Schema.String.annotate({ description: "Replacement text" }),
      }),
    ).annotate({ description: "One or more targeted replacements, each matched against the original file" }),
  }),
  ({ path, edits }) =>
    Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (e) => e }).pipe(
      Effect.flatMap((text) => {
        const applied = applyEdits(text, path, edits)
        if ("error" in applied) return Effect.succeed(applied.error!)
        return Effect.tryPromise({ try: () => writeFile(path, applied.result!), catch: (e) => e }).pipe(
          Effect.as(`Successfully replaced ${edits.length} block(s) in ${path} (at line${applied.lines!.length === 1 ? "" : "s"} ${applied.lines!.join(", ")}).`),
        )
      }),
      Effect.catch((e) => Effect.succeed(`could not edit ${path}: ${e instanceof Error ? e.message : String(e)}`)),
    ),
)

// The tools, in Pi's order (read, bash, edit, write). System Two doesn't get them as separate tools: it uses them from
// the kernel, where they're built-ins (kernel-builtins.ts).
export const TOOLS: ReadonlyArray<Tool> = [readTool, bashTool, editTool, writeTool]
