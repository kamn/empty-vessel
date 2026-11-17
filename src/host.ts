// empty-vessel's core as a host sees it: everything a program that runs sessions for a channel (empty-vessel-agent: Telegram,
// Typhlos, cron) may import, from one place, "empty-vessel/host". A host is not a plugin: it doesn't provide a model, it
// puts the core's parts together and runs turns, so its door is wider than src/core.ts. Its API is snapshotted in
// host-api.txt and versioned by CORE_VERSION with the plugins' (test/core-api.test.ts says which bump a change needs).
// ponytail: wide, and shaped like the core's insides (resuming a turn, loading a conversation). Narrow it by moving the
// agent's worker (its src/core-worker.ts) in here as one "run a session" function, once host-api.txt shows what churns.
export { CORE_VERSION } from "./base/version"

// Settings, and the plugins that are configured (the layers a session needs, from config.json).
export { Config } from "./base/config"
export { pluginSettings } from "./plugins/plugin"
export { ActionGuardFromConfig, copies, PLUGINS, StoreAndMemoryFromConfig, SystemOneFromConfig } from "./plugins/index"
export { SystemTwoLayers } from "./loop/systems"
export { closeSources, makeSources, useSources } from "./loop/sources"
export { localSource } from "./kernel/mcp"

// A session: its files, its runner (one turn at a time, steering, questions), and going on with an unfinished turn.
export { Store } from "./base/store"
export { logEntries, makeSession, openSession, SESSIONS } from "./base/session"
export { makeSessionRunner, type SessionRunner } from "./interaction"
export { type ModelOwner, resumeAgent } from "./answer"
export { answerOf, loadConversation, unfinishedTurn, useSystemTwo } from "./loop/resume"
export { newConversation } from "./loop/turnkit"
export { ensureAgentsGuide } from "./base/agents"
export { HostBriefing } from "./base/context"
export { AskUser } from "./ui/ask"
export { Background } from "./base/background"
export { Usage } from "./base/usage"
export { attach } from "./attach"

// Jobs and reminders the host keeps, what a turn reports when it ends, and the memory review a host queues.
export { DETACHED, TIMER, Timers } from "./loop/jobs"
export { TurnReports } from "./loop/endturn"
export { countTurn, NO_WINDOW, type TurnReport, type Window } from "./loop/signals"
export { curateMemory } from "./learning/reviewer"

// What a host shows or sends: charts, a project's learned tools, voice and images.
export { Chart, chartTable, deliveryError } from "./base/delivery"
export { libraryDir, loadLibrary, loadPool } from "./loop/library"
export { makeMedia } from "./base/media"

// One owner per store or bot (a lease), and the Telegram transport the agent's host drives.
export { processStart, takeLease } from "./base/files"
export { makeTelegramChannel } from "./plugins/telegram/channel"
export { settings as telegramSettings } from "./plugins/telegram/config"
export { telegramMedia } from "./plugins/telegram/media"
