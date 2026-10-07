import { Effect, Redacted } from "effect"

export type Http = (url: string, init: RequestInit) => Promise<Response>
export class TelegramError extends Error {
  constructor(readonly status = 0, readonly retryAfter?: number) {
    super(status ? `Telegram request failed (${status})` : "Telegram request failed")
  }
}

// Never retain an upstream exception, response description, request URL or token.
export const telegramApi = (token: Redacted.Redacted<string>, http: Http = fetch) => {
  const once = <A>(method: string, body: object): Effect.Effect<A, TelegramError> =>
    Effect.tryPromise({
      try: (signal) => http(`https://api.telegram.org/bot${Redacted.value(token)}/${method}`, {
        method: "POST", redirect: "error",
        headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
        body: body instanceof FormData ? body : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
      }).then((response) => response.json().then((data: any) => {
        if (!response.ok || data?.ok !== true) {
          const status = response.ok ? data?.error_code : response.status
          const seconds = data?.parameters?.retry_after
          throw new TelegramError(Number.isInteger(status) ? status : 0,
            typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined)
        }

        return data.result as A
      }, () => { throw new TelegramError(response.status >= 400 ? response.status : 0) })),
      catch: (error) => error instanceof TelegramError ? error : new TelegramError(),
    })

  const call = <A>(method: string, body: object = {}, attempt = 0): Effect.Effect<A, TelegramError> =>
    once<A>(method, body).pipe(Effect.catch((error) => {
      if (attempt >= 3 || !(error.status === 0 || error.status === 429 || error.status >= 500)) {
        return Effect.fail(error)
      }

      // Bound total waiting too; don't retry earlier than a long server-requested delay.
      const seconds = error.retryAfter ?? Math.min(2 ** attempt, 8)
      if (seconds > 60) return Effect.fail(error)
      return Effect.sleep(seconds * 1000).pipe(Effect.andThen(call<A>(method, body, attempt + 1)))
    }))

  return { call }
}

export const splitText = (text: string): string[] => {
  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    let end = Math.min(start + 4096, text.length)
    const code = text.charCodeAt(end - 1)
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--
    chunks.push(text.slice(start, end))
    start = end
  }

  return chunks
}
