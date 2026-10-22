import { resolve } from "node:path"
import { Effect } from "effect"
import { Channel } from "./base/channel"
import { Config } from "./base/config"
import { Store } from "./base/store"
import { Background } from "./base/background"
import { logEntries, makeSession, openSession, SESSIONS } from "./base/session"
import { newConversation } from "./loop/turnkit"
import { loadConversation, useSystemTwo } from "./loop/resume"
import { makeSessionRunner } from "./interaction"
import { serveChannel } from "./channel-host"

// The same session, providers and tools as the terminal; the transport only owns
// delivery and its saved pointer. Never silently resume a different project.
export const channelRoot = (resume?: string) => Effect.scoped(Effect.gen(function* () {
  const channel = yield* Channel
  const store = yield* Store
  const config = yield* Config
  const background = yield* Background
  const key = resume ?? (yield* channel.loadSession)

  if (key) {
    if (!/^sessions\/[a-zA-Z0-9-]+$/.test(key)) return yield* Effect.fail(new Error("Invalid channel session key"))
    const saved = yield* store.get(`${key}/main.jsonl`)
    const first = logEntries(saved)[0]
    const project = first?.role === "project" && typeof first.text === "string" ? first.text : undefined

    if (!project || resolve(project) !== resolve(process.cwd())) {
      return yield* Effect.fail(new Error("The channel session is missing or belongs to another project; select a session from this directory with --resume"))
    }
  }

  const session = key ? yield* openSession(key) : yield* makeSession(SESSIONS)
  const conversation = key ? loadConversation(session.dir) : newConversation()
  yield* useSystemTwo(session, conversation, config.systemTwo.use)
  yield* channel.saveSession(session.key)
  yield* channel.send(`${key ? "Resumed" : "Started"} session ${session.id}.\nSend /help for commands. Work interrupted by a previous process exit is not automatically rerun; check project state before retrying.`)

  yield* serveChannel(channel, session.id, (adapters) => makeSessionRunner(session, conversation, adapters)).pipe(
    Effect.ensuring(background.drain),
  )
}))
