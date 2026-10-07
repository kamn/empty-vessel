import { Context } from "effect"

// What the user typed while a turn runs, for System Two to read mid-run (steering): the TUI puts messages in, and
// `take` hands over (and removes) the ones not yet read. src/system-two/dispatch.ts delivers them with the next tool
// result, src/system-two/loop.ts before the next request. By default there's never anything (the plain prompt, -p).
export const Inbox = Context.Reference<{ readonly take: () => ReadonlyArray<string> }>("empty-vessel/Inbox", { defaultValue: () => ({ take: () => [] }) })

// A channel owns one queue per session. Reading consumes messages; draining returns
// leftovers without claiming the agent read them (the channel can send them next).
export const makeInbox = (onRead: (text: string) => void = () => {}) => {
  const messages: Array<string> = []
  const drain = (): Array<string> => messages.splice(0)

  const take = (): ReadonlyArray<string> => {
    const taken = drain()

    for (const text of taken) {
      onRead(text)
    }

    return taken
  }

  return {
    push: (text: string): void => { messages.push(text) },
    take,
    drain,
  }
}
