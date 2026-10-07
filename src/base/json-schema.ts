import * as Schema from "effect/Schema"

// The JSON schema a strict structured-output request needs: Effect's version, every object in it closed to extra
// fields (strict mode requires it at every level, not only the top: adoption's proposals are objects in an array).
const closed = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(closed)
  if (!node || typeof node !== "object") return node
  const out = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, closed(v)]))
  return (node as { type?: unknown }).type === "object" ? { ...out, additionalProperties: false } : out
}
export const jsonSchemaFor = (schema: Schema.Top) => closed(Schema.toJsonSchemaDocument(schema).schema) as Record<string, unknown>
