import { Context, type Effect, type Scope } from "effect"

// A conversation transport owns its session pointer and receives messages until its scope closes.
// Terminal routing is built into the entry point, not a Channel provider.
export class Channel extends Context.Service<Channel, {
  // Omit automatic usage summaries on transports that prefer quieter replies.
  readonly hideUsageSummaries?: boolean
  readonly loadSession: Effect.Effect<string | undefined, Error>
  readonly saveSession: (id: string) => Effect.Effect<void, Error>
  // Permanent replies (notes, questions, final answers) end the current progress message. Sends give the transport's
  // message ID when it has one (Telegram: the last chunk's), so a durable outbox can record what was delivered.
  readonly send: (text: string) => Effect.Effect<number | void, Error>
  // Await actual attachment delivery; message text is supplied as the caption.
  readonly sendFile?: (path: string, caption?: string) => Effect.Effect<number | void, Error>
  // A spoken reply (an OGG/Opus file) as a voice message.
  readonly sendVoice?: (path: string, caption?: string) => Effect.Effect<number | void, Error>
  // Optional live progress: replace the previous summary instead of sending another message.
  // The first update after a permanent reply starts a new progress message.
  // Hosts fall back to send when a transport does not support updates.
  readonly progress?: (summary: string) => Effect.Effect<void, Error>
  // A message counts as received only once onMessage's Effect completes: one whose handling never finished (a crash) is
  // delivered again, with the same requestId (Telegram: tg:<chat_id>:<message_id>), so the receiver can skip a repeat.
  // voice: the text is a transcribed voice note.
  readonly listen: (onMessage: (message: { text: string; requestId?: string; voice?: true }) => Effect.Effect<void>) => Effect.Effect<void, Error, Scope.Scope>
}>()("empty-vessel/Channel") {}
