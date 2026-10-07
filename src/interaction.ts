import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { agentCommand, answer, firstAgent, modelCommand, stopped, userCommand, type ModelOwner } from "./answer"
import type { Config } from "./base/config"
import { Events } from "./base/events"
import { Delivery } from "./base/delivery"
import { Inbox, makeInbox } from "./base/inbox"
import type { SessionHandle } from "./base/session"
import { refineCommand } from "./loop/refine"
import { reviewCommand } from "./loop/review"
import { skillCommand } from "./loop/skill-commands"
import type { Conversation } from "./loop/turnkit"
import type { SystemOne } from "./system-one/systemone"
import { AskUser } from "./ui/ask"

export type SessionReply = { readonly reply: string; readonly usage: ReadonlyArray<string>; readonly total?: string }
export type InteractionAnswer = { readonly answer: string; readonly note?: string }
export interface SessionRunner {
  readonly run: (input: string) => Effect.Effect<SessionReply, string>
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
export const interactionOperations = { answer, modelCommand, agentCommand, firstAgent, stopped, userCommand, refineCommand, reviewCommand, skillCommand }
export const makeSessionRunner = (session: SessionHandle, conversation: Conversation, adapters: InteractionAdapters, operations = interactionOperations) =>
  Effect.gen(function* () {
    let services = yield* Effect.context<Effect.Services<ReturnType<typeof answer>> | Config | SystemOne>() // an agent or /model replaces System Two's
    let active: { fiber?: Fiber.Fiber<unknown, unknown>; stopping: boolean; done: Deferred.Deferred<void> } | undefined
    let pending: Deferred.Deferred<InteractionAnswer> | undefined
    const inbox = makeInbox(adapters.onSteerRead)
    const owner: ModelOwner = {}
    yield* Effect.addFinalizer(() => owner.current ? Scope.close(owner.current, Exit.void) : Effect.void)

    const ask = adapters.ask ?? AskUser.of({
      ask: (questions) => Effect.forEach(questions, (question) => Effect.gen(function* () {
        const waiting = yield* Deferred.make<InteractionAnswer>()
        pending = waiting
        return yield* Effect.gen(function* () {
          yield* adapters.presentQuestion?.(question) ?? Effect.void
          return { question: question.question, ...yield* Deferred.await(waiting) }
        }).pipe(Effect.ensuring(Effect.sync(() => { if (pending === waiting) pending = undefined })))
      })),
    })
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(
      Effect.provideService(Events, adapters.events), Effect.provideService(AskUser, ask),
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
          active = undefined
          yield* Deferred.succeed(state.done, undefined)
        })))
      }))

    const run = (input: string): Effect.Effect<SessionReply, string> => Effect.suspend(() => {
      const refine = /^\/refine(?=\s|$)/.test(input)
      const review = /^\/review(?=\s|$)/.test(input)
      const model = input.match(/^\/model(?=\s|$)\s*(\S*)/)
      const named = input.match(/^\/agent(?=\s|$)\s*(\S*)/)
      let turnInput = input
      let skillOnly = false
      const work = Effect.gen(function* () {
        if (refine) return { reply: yield* provide(operations.refineCommand(input.slice("/refine".length))), usage: [] }
        // /review (save [n…]): look back over this project's sessions (src/loop/review.ts).
        if (review) return { reply: yield* provide(operations.reviewCommand(input.slice("/review".length))), usage: [] }

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

        const skill = yield* operations.skillCommand(session, conversation, input)
        if (skill?.kind === "reply") {
          skillOnly = true
          return { reply: skill.reply, usage: [] }
        }
        if (skill?.kind === "activation") turnInput = skill.content

        // Before the conversation's first message, System One picks its agent.
        const picked = yield* operations.firstAgent(session, conversation, turnInput, services, owner)
        services = picked.services
        if (picked.line) yield* adapters.events.emit({ kind: "note", depth: 0, text: picked.line })

        inbox.drain() // the host owns leftovers between turns (TUI keeps its own displayed queue)
        const result = yield* provide(operations.answer(session, turnInput, conversation))
        conversation.history.push({ user: input, answer: result.reply })
        return { reply: result.reply, usage: [...result.remembered, result.brief.turn], total: result.brief.session }
      })
      const interrupted = Effect.gen(function* () {
        if (refine || review || model || named || skillOnly) return { reply: "(stopped)", usage: [] }
        const reply = yield* provide(operations.stopped(session, turnInput, conversation)).pipe(Effect.orElseSucceed(() => "(stopped)"))
        conversation.history.push({ user: input, answer: reply })
        return { reply, usage: [] }
      })

      return execute(work.pipe(Effect.ensuring(Effect.sync(() => { conversation.explicitSkill = false }))), interrupted)
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
      drain: Effect.sync(inbox.drain),
    }

    return runner
  })
