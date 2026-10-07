import { Effect } from "effect"
import { makeSessionRunner } from "./interaction"
import { Config } from "./base/config"
import { Events } from "./base/events"
import type { SessionHandle } from "./base/session"
import type { Conversation } from "./loop/turnkit"
import { init, Message, TurnRunner } from "./ui/tui/app"
import { setTheme } from "./ui/tui/style"
import { runTui } from "./ui/tui/runtime"
import { clipboardImage, imagesIn } from "./base/images"

// The TUI (config `ui: "tui"`): the same turns as the plain prompt, drawn by src/ui/tui. Keys are read raw, so
// Ctrl+C reaches the TUI as a key (it stops the turn) rather than as a signal. While it runs, the loop's events and
// questions go to the TUI; once it has closed (the reviewer can still be working), events print as before.
export const tui = (session: SessionHandle, conversation: Conversation, status: string, banner?: string) =>
  Effect.gen(function* () {
    const config = yield* Config
    yield* Effect.sync(() => setTheme(config.theme))

    let dispatch = (_: Message) => {}
    let closed = false
    const plain = Events.defaultValue()
    const events = { emit: (e: Parameters<typeof plain.emit>[0]) => (closed ? plain.emit(e) : Effect.sync(() => dispatch(Message.GotEvent(e)))) }

    const runner = yield* makeSessionRunner(session, conversation, {
      events,
      presentQuestion: ({ question, options }) => Effect.sync(() => dispatch(Message.AskedUser({ question, options: [...options] }))),
      onSteerRead: (text) => dispatch(Message.SteerRead({ text })),
    })

    yield* runTui(init(status, banner), (d) => { dispatch = d }, {
      attach: (text, from) => imagesIn(text, process.cwd(), from),
      clipboard: () => clipboardImage()?.replace(/ /g, "\\ "),
      copy: (text) => { Bun.spawnSync(["pbcopy"], { stdin: new TextEncoder().encode(text) }) }, // ponytail: macOS; OSC 52 for others
    }).pipe(
      Effect.provideService(TurnRunner, { ...runner, flag: (note, where) => session.record("flag", note, where).pipe(Effect.ignore) }),
      Effect.ensuring(Effect.sync(() => { closed = true })),
    )
  }).pipe(Effect.scoped)
