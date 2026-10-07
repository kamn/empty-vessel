import { Context, type Effect, type Scope } from "effect"

// A conversation transport owns its session pointer and receives messages until its scope closes.
// Terminal routing is built into the entry point, not a Channel provider.
export class Channel extends Context.Service<Channel, {
  // Omit automatic usage summaries on transports that prefer quieter replies.
  readonly hideUsageSummaries?: boolean
  readonly loadSession: Effect.Effect<string | undefined, Error>
  readonly saveSession: (id: string) => Effect.Effect<void, Error>
  // Permanent replies (notes, questions, final answers) end the current progress message.
  readonly send: (text: string) => Effect.Effect<void, Error>
  // Await actual attachment delivery; message text is supplied as the caption.
  readonly sendFile?: (path: string, caption?: string) => Effect.Effect<void, Error>
  // Optional live progress: replace the previous summary instead of sending another message.
  // The first update after a permanent reply starts a new progress message.
  // Hosts fall back to send when a transport does not support updates.
  readonly progress?: (summary: string) => Effect.Effect<void, Error>
  readonly listen: (onMessage: (text: string) => Effect.Effect<void>) => Effect.Effect<void, Error, Scope.Scope>
}>()("empty-vessel/Channel") {}
