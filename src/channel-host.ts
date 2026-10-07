import { Cause, Console, Effect, Exit, Queue } from "effect"
import type { Channel } from "./base/channel"
import type { InteractionAdapters, SessionRunner } from "./interaction"

type Input = { readonly kind: "message"; readonly text: string }
  | { readonly kind: "done"; readonly exit: Exit.Exit<{ reply: string; usage: ReadonlyArray<string>; total?: string }, string> }

// One actor owns routing; receiving and sending run separately, so a slow model or
// Telegram request never prevents a question answer or stop from being received.
export const serveChannel = <R>(channel: Channel["Service"], sessionId: string,
  makeRunner: (adapters: InteractionAdapters) => Effect.Effect<SessionRunner, never, R>) => Effect.gen(function* () {
  const incoming = yield* Queue.unbounded<Input>()
  const outgoing = yield* Queue.unbounded<{ text: string; progress: boolean }>()
  const waiting: string[] = []
  let active = false
  let asking = false
  let options: ReadonlyArray<string> = []
  let status = "Ready"
  let lastProgress = 0
  const say = (text: string, progress = false) => Effect.sync(() => {
    if (text) Queue.offerUnsafe(outgoing, { text, progress })
  })

  const runner = yield* makeRunner({
    ...(channel.sendFile ? { sendFile: (path: string, caption?: string) => channel.sendFile!(path, caption) } : {}),
    presentQuestion: ({ question, options: offered }) => Effect.gen(function* () {
      asking = true
      options = offered
      yield* say(`${question}\n${options.map((option, i) => `${i + 1}. ${option}`).join("\n")}\nReply with a number or your own answer.`)
    }),
    events: { emit: (event) => Effect.gen(function* () {
      status = event.text
      if (event.kind === "note" || event.kind === "error") return yield* say(event.text)
      if (event.kind === "activity" && (!channel.progress || !event.summary)) return
      if (channel.progress) return yield* say((event.summary ?? event.text).slice(0, 1000), true)
      const now = yield* Effect.sync(() => Date.now())
      if (now - lastProgress < 3000) return
      lastProgress = now
      yield* say(event.text.slice(0, 1000))
    }) },
  })
  yield* Effect.addFinalizer(() => runner.stop)

  const start = (input: string) => Effect.gen(function* () {
    active = true
    asking = false
    status = "Working"
    yield* say("Working…", true)
    const shell = input.match(/^(!!?)\s*(.*\S)/)
    const work = shell
      ? runner.shell(shell[2]!, shell[1] === "!").pipe(Effect.map((reply) => ({ reply, usage: [] as string[] })))
      : runner.run(input)

    yield* Effect.forkChild(Effect.exit(work).pipe(Effect.flatMap((exit) => Effect.sync(() => {
      Queue.offerUnsafe(incoming, { kind: "done", exit })
    }))))
  })

  const help = "Send a message to work in this project's session.\n/stop — stop the current work\n/status — show session and activity\n/model [name] — show or change model\n/refine — learn from previous turns\n!command / !!command — shell (shared / private output)\n/exit — stop this channel process\nMessages during work steer the agent; replies to questions answer them."
  const actor = Effect.gen(function* () {
    while (true) {
      const input = yield* Queue.take(incoming)

      if (input.kind === "done") {
        active = false
        asking = false
        status = "Ready"
        if (Exit.isSuccess(input.exit)) {
          yield* say(input.exit.value.reply)
          if (!channel.hideUsageSummaries) {
            for (const line of input.exit.value.usage) yield* say(line)
            if (input.exit.value.total) yield* say(input.exit.value.total)
          }
        } else {
          yield* Console.error(Cause.pretty(input.exit.cause))
          yield* say("The interaction failed. Check the local log and project state before retrying; it was not rerun.")
        }
        waiting.push(...yield* runner.drain)
        const next = waiting.shift()
        if (next !== undefined) yield* start(next)
        continue
      }

      const text = input.text.trim()
      if (!text) continue
      if (text === "/start" || text === "/help") { yield* say(help); continue }
      if (text === "/status") { yield* say(`Session ${sessionId}\n${status}`); continue }

      if (text === "/stop" || text === "/exit") {
        waiting.length = 0
        asking = false
        yield* runner.stop
        yield* runner.drain
        if (text === "/exit") {
          yield* channel.send(`Channel stopped. Session ${sessionId} will resume on the next launch.`)
          return
        }
        yield* say(active ? "Stop requested; queued messages cleared." : "Nothing is running; queued messages cleared.")
        continue
      }

      if (asking) {
        asking = false
        yield* runner.answer({ answer: /^[1-3]$/.test(text) ? options[Number(text) - 1] ?? input.text : input.text })
      } else if (active) {
        if (/^\/(model|refine)\b/.test(text) || /^!/.test(text)) waiting.push(input.text)
        else yield* runner.steer(input.text)
      } else yield* start(input.text)
    }
  })

  const sender = Effect.forever(Queue.take(outgoing).pipe(Effect.flatMap(({ text, progress }) =>
    progress && channel.progress ? channel.progress(text) : channel.send(text),
  )))
  const listener = channel.listen((text) => Effect.sync(() => { Queue.offerUnsafe(incoming, { kind: "message", text }) }))
  yield* Effect.raceFirst(actor, Effect.raceFirst(sender, listener))
})
