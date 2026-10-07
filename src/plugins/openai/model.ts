import { Data, Effect, Redacted } from "effect"
import type { Model, ModelRequest } from "empty-vessel"

// Any model behind an OpenAI-compatible Chat Completions API (OpenAI itself, a local server, a router), as empty-vessel's
// System Two: the core runs the loop (src/system-two/loop.ts); this sends one request and reads its reply. Written
// against the core's API alone.

class OpenAIError extends Data.TaggedError("OpenAIError")<{ message: string; status?: number }> {}

type Part = { type?: string; text?: string; image_url?: string }
type Item = { type?: string; role?: string; content?: Array<Part>; name?: string; arguments?: string; call_id?: string; output?: unknown }

// The core's thread (Responses-style items) as chat messages: its text and images, tool calls grouped into the
// assistant message they came in, their results as tool messages. Anything else (another model's reasoning) is left out.
export const toMessages = (instructions: string, thread: ReadonlyArray<unknown>) => {
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: instructions }]
  for (const item of thread as ReadonlyArray<Item>) {
    const last = messages.at(-1)!
    if (item.role === "user") messages.push({ role: "user", content: (item.content ?? []).map((p) => (p.type === "input_image" ? { type: "image_url", image_url: { url: p.image_url } } : { type: "text", text: p.text ?? "" })) })
    else if (item.role === "assistant") messages.push({ role: "assistant", content: (item.content ?? []).map((p) => p.text ?? "").join("") })
    else if (item.type === "function_call") {
      const call = { id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }
      if (last.role === "assistant" && Array.isArray(last.tool_calls)) last.tool_calls.push(call)
      else messages.push({ role: "assistant", content: null, tool_calls: [call] })
    } else if (item.type === "function_call_output") messages.push({ role: "tool", tool_call_id: item.call_id, content: String(item.output) })
  }
  return messages
}

type Reply = {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } }
}

// `baseUrl`: up to /v1 (…/chat/completions is added). A 429 or 5xx is worth one more try; anything else fails the run.
export const openAIModel = (baseUrl: string, model: string, apiKey?: Redacted.Redacted<string>): Model => ({
  name: model,
  complete: ({ instructions, thread, tools, schema }: ModelRequest) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${Redacted.value(apiKey)}` } : {}) },
          body: JSON.stringify({
            model, messages: toMessages(instructions, thread),
            ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: t })) } : {}),
            ...(schema ? { response_format: { type: "json_schema", json_schema: { name: schema.name, schema: schema.schema, strict: true } } } : {}),
          }),
        })
        if (!response.ok) throw new OpenAIError({ message: `${response.status} ${(await response.text()).slice(0, 300)}`, status: response.status })
        return (await response.json()) as Reply
      },
      catch: (e) => (e instanceof OpenAIError ? e : new OpenAIError({ message: String(e) })),
    }).pipe(
      Effect.retry({ times: 1, while: (e) => e.status === undefined || e.status === 429 || e.status >= 500 }),
      Effect.map((reply) => {
        const message = reply.choices?.[0]?.message ?? {}
        const u = reply.usage ?? {}
        return {
          text: message.content ?? "", keep: [], thinking: "", searches: [],
          calls: (message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
          usage: { input: u.prompt_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? 0, output: u.completion_tokens ?? 0, thinking: u.completion_tokens_details?.reasoning_tokens ?? 0 },
        }
      }),
    ),
})
