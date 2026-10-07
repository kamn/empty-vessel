import { appendFile, mkdir, readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Context, Effect, Layer } from "effect"
import { writeAtomic } from "./files"
import { EMPTY_VESSEL_HOME } from "./home"

// What empty-vessel keeps between runs (sessions, notes, the library), by key: a path such as "sessions/<id>/main.jsonl".
// Kept narrow (get, put, append, list) so more than a disk can back it: ~/.empty-vessel here, a Durable Object or R2 in
// the cloud. Callers move onto it one at a time.
export class Store extends Context.Service<Store, {
  readonly get: (key: string) => Effect.Effect<string | undefined>
  readonly put: (key: string, text: string) => Effect.Effect<void>
  readonly append: (key: string, text: string) => Effect.Effect<void>
  readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<string>>
  readonly folder: (key: string) => string // the key as a folder on this machine, for what still needs real files (the kernel)
}>()("empty-vessel/Store") {}

// The Store on disk, under `home`. get of a missing key is undefined; put is all-or-nothing (writeAtomic); list gives
// the names directly under a prefix, sorted, and none if there's nothing there.
export const diskStore = (home = EMPTY_VESSEL_HOME) =>
  Layer.succeed(Store, {
    get: (key) => Effect.promise(() => readFile(join(home, key), "utf8").catch(() => undefined)),
    put: (key, text) => writeAtomic(join(home, key), text),
    append: (key, text) => Effect.promise(() => mkdir(dirname(join(home, key)), { recursive: true }).then(() => appendFile(join(home, key), text))),
    list: (prefix) => Effect.promise(() => readdir(join(home, prefix)).then((names) => names.sort(), () => [])),
    folder: (key) => join(home, key),
  })
