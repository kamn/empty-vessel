import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope, Semaphore } from "effect"
import { agentCommand, answer, firstAgent, modelCommand, stopped, userCommand, type ModelOwner } from "./answer"
import type { Config } from "./base/config"
import { Events } from "./base/events"
import { Delivery } from "./base/delivery"
import { Inbox, makeInbox } from "./base/inbox"
import { writeAtomic } from "./base/files"
import type { SessionHandle } from "./base/session"
import { memoryCommand } from "./learning/notes"
import { refineCommand } from "./loop/refine"
import { reviewCommand } from "./loop/review"
import { redoCommand, undoCommand } from "./loop/checkpoint"
import { compactCommand } from "./loop/compact"
import { skillCommand } from "./loop/skill-commands"
import { Timers } from "./loop/jobs"
import type { Conversation } from "./loop/turnkit"
import type { Unfinished } from "./loop/resume"
import type { SystemOne } from "./system-one/systemone"
import { AskUser } from "./ui/ask"

export type SessionReply = { readonly reply: string; readonly usage: ReadonlyArray<string>; readonly total?: string }
export type InteractionAnswer = { readonly answer: string; readonly note?: string }
export interface SessionRunner {
  // `resume`: the turn a restart cut short, going on (its message as `input`: src/loop/resume.ts, unfinishedTurn).
  readonly run: (input: string, resume?: Unfinished) => Effect.Effect<SessionReply, string>
  readonly shell: (command: string, share: boolean) => Effect.Effect<string, string>
  readonly stop: Effect.Effect<void>
  readonly answer: (reply: InteractionAnswer) => Effect.Effect<void>
  readonly steer: (text: string) => Effect.Effect<void>
  readonly drain: Effect.Effect<ReadonlyArray<string>>
}
export interface InteractionAdapters {
  readonly sendFile?: (path: string, caption?: string) => Effect.Effect<void, Error>
  readonly events: ReturnType<typeof Events.defaultValue>
  readonly ask?: AskUser["Service"]
  readonly presentQuestion?: (question: { readonly question: string; readonly options: ReadonlyArray<string> }) => Effect.Effect<void>
  readonly onSteerRead?: (text: string) => void
}

// Injection keeps lifecycle tests independent of providers, kernels and credentials.
export const interactionOperations = { answer, modelCommand, agentCommand, firstAgent, stopped, userCommand, refineCommand, reviewCommand, memoryCommand, skillCommand, undoCommand, redoCommand }
export const makeSessionRunner = (session: SessionHandle, conversation: Conversation, adapters: InteractionAdapters, operations = interactionOperations) =>
  Effect.gen(function* () {
    let services = yield* Effect.context<Effect.Services<ReturnType<typeof answer>> | Config | SystemOne>() // an agent or /model replaces System Two's
    let active: { fiber?: Fiber.Fiber<unknown, unknown>; stopping: boolean; done: Deferred.Deferred<void> } | undefined
    let pending: Deferred.Deferred<InteractionAnswer> | undefined
    const inbox = makeInbox(adapters.onSteerRead)
    // What a turn left unread, set aside when it ends: the host takes them (drain: a channel sends them next) or not
    // (the TUI keeps its own queue); a new turn drops them. Messages sent while a turn starts stay in the inbox for it.
    const leftovers: Array<string> = []
    const owner: ModelOwner = {}
    yield* Effect.addFinalizer(() => owner.current ? Scope.close(owner.current, Exit.void) : Effect.void)

    // live.json in the session folder: the running turn's events so far, for a client that joins mid-turn (the agent's
    // attach). Rewritten whole (writeAtomic) at most every 500 ms, and once more when the turn ends (running: false).
    // ponytail: the last 200 events only; a joiner reads the rest from main.jsonl.
    const live = { running: false, input: "", events: [] as Array<Omit<Parameters<InteractionAdapters["events"]["emit"]>[0], "body">>, activity: "" }
    const writing = Semaphore.makeUnsafe(1)
    let due = false
    const flush = writing.withPermits(1)(Effect.suspend(() => {
      due = false
      return typeof session.dir === "string" ? writeAtomic(`${session.dir}/live.json`, JSON.stringify({ ...live, at: Date.now() })) : Effect.void
    })).pipe(Effect.catchCause(() => Effect.void))
    const events: InteractionAdapters["events"] = {
      emit: (event) => adapters.events.emit(event).pipe(Effect.andThen(Effect.suspend(() => {
        if (!live.running) return Effect.void
        if (event.kind === "activity") live.activity = event.text
        else live.events = [...live.events, { kind: event.kind, depth: event.depth, text: event.text, ...(event.summary ? { summary: event.summary } : {}) }].slice(-200)
        if (due) return Effect.void
        due = true
        return Effect.forkDetach(Effect.sleep("500 millis").pipe(Effect.andThen(flush)))
      })), Effect.asVoid),
    }

    // One question at a time: sub-agents (or a guard's approval and ask_user) can ask together, and with one pending
    // answer a reply to the first ("1": allow) would go to the second. The others wait their turn, shown one by one.
    const asking = Semaphore.makeUnsafe(1)
    const ask = adapters.ask ?? AskUser.of({
      ask: (questions) => Effect.forEach(questions, (question) => asking.withPermit(Effect.gen(function* () {
        const waiting = yield* Deferred.make<InteractionAnswer>()
        pending = waiting
        return yield* Effect.gen(function* () {
          yield* adapters.presentQuestion?.(question) ?? Effect.void
          return { question: question.question, ...yield* Deferred.await(waiting) }
        }).pipe(Effect.ensuring(Effect.sync(() => { if (pending === waiting) pending = undefined })))
      }))),
    })
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
      Effect.provideService(Events, events), Effect.provideService(AskUser, ask),
      Effect.provideService(Inbox, inbox),
      Effect.provideService(Delivery, adapters.sendFile ? { sendFile: adapters.sendFile } : Delivery.defaultValue()),
      Effect.provideContext(services),
    )

    // Acquire ownership without yielding; retain it until interruption and bookkeeping finish.
    const execute = <A>(work: Effect.Effect<A, unknown>, interrupted: Effect.Effect<A, string>): Effect.Effect<A, string> =>
      Effect.uninterruptibleMask((restore) => Effect.suspend(() => {
        if (active) return Effect.fail("a session interaction is already running")
        const state = { stopping: false, done: Deferred.makeUnsafe<void>(), fiber: undefined as Fiber.Fiber<unknown, unknown> | undefined }
        active = state

        return Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(restore(work))
          state.fiber = fiber
          if (state.stopping) yield* Fiber.interrupt(fiber)
          const exit = yield* restore(Fiber.await(fiber)).pipe(Effect.onInterrupt(() => Effect.gen(function* () {
            state.stopping = true
            yield* Fiber.interrupt(fiber)
            yield* interrupted.pipe(Effect.ignore)
          })))

          if (Exit.isSuccess(exit)) return exit.value
          if (state.stopping) return yield* interrupted
          return yield* Effect.fail(Cause.pretty(exit.cause))
        }).pipe(Effect.ensuring(Effect.gen(function* () {
          leftovers.push(...inbox.drain()) // unread when it ended (a turn or a !shell): the host's, not the next turn's
          active = undefined
          yield* Deferred.succeed(state.done, undefined)
        })))
      }))

    const run = (input: string, resume?: Unfinished): Effect.Effect<SessionReply, string> => Effect.suspend(() => {
      leftovers.length = 0
      conversation.inputRecorded = resume !== undefined // a stop from here on writes this message if the turn hadn't yet (src/answer.ts)
      // A resumed turn's message is the turn's own (a command never made one): no command is read from it. Nor from a
      // run no one is attending (a job, a detached sub-agent, a review): "/skills approve x" there is only text to the model.
      const origin = Context.get(services, Timers).origin() ?? "user"
      const commands = !resume && origin === "user"
      const typed = commands ? input : ""
      const refine = /^\/refine(?=\s|$)/.test(typed)
      const review = /^\/review(?=\s|$)/.test(typed)
      const memory = /^\/memory(?=\s|$)/.test(typed)
      const undo = /^\/undo\s*$/.test(typed)
      const redo = /^\/redo\s*$/.test(typed)
      const compact = /^\/compact\s*$/.test(typed)
      const model = typed.match(/^\/model(?=\s|$)\s*(\S*)/)
      const named = typed.match(/^\/agent(?=\s|$)\s*(\S*)/)
      let turnInput = input
      let skillOnly = false
      const work = Effect.gen(function* () {
        if (refine) return { reply: yield* provide(operations.refineCommand(input.slice("/refine".length))), usage: [] }
        // /review (save [n…]): look back over this project's sessions (src/loop/review.ts).
        if (review) return { reply: yield* provide(operations.reviewCommand(input.slice("/review".length))), usage: [] }
        // /memory (remove <scope> <n>): what empty-vessel remembers (src/learning/notes.ts); edit says where the file is.
        if (memory) return { reply: yield* provide(operations.memoryCommand(input.slice("/memory".length))), usage: [] }

        // /undo: the files back to before the last turn that changed them (src/loop/checkpoint.ts).
        if (undo) return { reply: yield* provide(operations.undoCommand(session, conversation)), usage: [] }
        if (redo) return { reply: yield* provide(operations.redoCommand(session, conversation)), usage: [] }

        // /compact: System Two's conversation is compacted at the start of the next message (src/loop/compact.ts).
        if (compact) return { reply: yield* compactCommand(conversation), usage: [] }

        if (model) {
          const switched = yield* operations.modelCommand(session, conversation, model[1]!, services, owner)
          services = switched.services
          return { reply: switched.reply, usage: [] }
        }

        // /agent [name]: which agent this conversation works as; before the first message, pick one yourself.
        if (named) {
          const chose = yield* operations.agentCommand(session, conversation, named[1]!, services, owner)
          services = chose.services
          return { reply: chose.reply ?? "", usage: [] }
        }

        const skill = !commands ? undefined : yield* provide(operations.skillCommand(session, conversation, input)) // AskUser: /skills install confirms
        if (skill?.kind === "reply") {
          skillOnly = true
          return { reply: skill.reply, usage: [] }
        }
        if (skill?.kind === "activation") turnInput = skill.content

        // Before the conversation's first message, System One picks its agent.
        const picked = yield* operations.firstAgent(session, conversation, turnInput, services, owner)
        services = picked.services
        if (picked.line) yield* events.emit({ kind: "note", depth: 0, text: picked.line })

        const result = yield* provide(operations.answer(session, turnInput, conversation, resume))
        conversation.history.push({ user: input, answer: result.reply, ...(origin !== "user" ? { origin } : {}) })
        return { reply: result.reply, usage: [...result.remembered, result.brief.turn], total: result.brief.session }
      })
      const interrupted = Effect.gen(function* () {
        if (refine || review || memory || undo || redo || compact || model || named || skillOnly) return { reply: "(stopped)", usage: [] }
        const reply = yield* provide(operations.stopped(session, turnInput, conversation)).pipe(Effect.orElseSucceed(() => "(stopped)"))
        conversation.history.push({ user: input, answer: reply, ...(origin !== "user" ? { origin } : {}) })
        return { reply, usage: [] }
      })

      const watched = Effect.sync(() => Object.assign(live, { running: true, input, events: [], activity: "" })).pipe(
        Effect.andThen(flush), Effect.andThen(work),
        Effect.ensuring(Effect.sync(() => { live.running = false }).pipe(Effect.andThen(flush))),
      )
      return execute(watched.pipe(Effect.ensuring(Effect.sync(() => { conversation.explicitSkill = false }))), interrupted)
    })
    const runner: SessionRunner = {
      run,
      shell: (command, share) => Effect.suspend(() => execute(provide(operations.userCommand(session, conversation, command, share)), Effect.succeed("(stopped)"))),
      stop: Effect.suspend(() => {
        const state = active
        if (!state) return Effect.void
        state.stopping = true
        return Effect.gen(function* () {
          if (state.fiber) yield* Fiber.interrupt(state.fiber)
          yield* Deferred.await(state.done)
        })
      }),
      answer: (reply) => Effect.suspend(() => pending ? Deferred.succeed(pending, reply) : Effect.void).pipe(Effect.asVoid),
      steer: (text) => Effect.sync(() => inbox.push(text)),
      drain: Effect.sync(() => [...leftovers.splice(0), ...inbox.drain()]),
    }

    return runner
  })
