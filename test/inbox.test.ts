import { expect, test } from "bun:test"
import { makeInbox } from "../src/base/inbox"

test("steering is ordered, consumed once, and acknowledged only when read", () => {
  const seen: string[] = []
  const inbox = makeInbox((text) => seen.push(text))
  inbox.push("first")
  inbox.push("second")

  expect(inbox.take()).toEqual(["first", "second"])
  expect(inbox.take()).toEqual([])
  expect(seen).toEqual(["first", "second"])
  inbox.push("next turn")
  expect(inbox.drain()).toEqual(["next turn"])
  expect(inbox.drain()).toEqual([])
  expect(seen).toEqual(["first", "second"])
})

test("sessions do not share steering messages", () => {
  const a = makeInbox()
  const b = makeInbox()
  a.push("private to a")

  expect(b.take()).toEqual([])
  expect(a.take()).toEqual(["private to a"])
})
