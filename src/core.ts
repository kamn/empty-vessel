// empty-vessel's core as plugins see it: everything a plugin may import, from
// one place. package.json's "exports" makes it the package's only door ("empty-vessel"); bundled plugins import it by that
// name and test/layers.test.ts keeps them from reaching past it. Its API is snapshotted in core-api.txt and versioned
// by CORE_VERSION (test/core-api.test.ts says which bump a change needs).
export { CORE_VERSION } from "./base/version"
export { EMPTY_VESSEL_HOME } from "./base/home"

// What a plugin is and provides.
export { type Plugin, PluginError, pluginSettings, type Provides, type SystemTwoParts } from "./plugins/plugin"
export type { PluginSetup, SetupAsk, SetupCheck } from "./base/plugin-setup"
export { Config, ConfigError } from "./base/config"
// A plugin's settings, each described (and its default, if it has one): `described({ model: setting(…) })`.
export { described, type Setting, setting, type Settings } from "./base/setting"

// The services a plugin can provide.
export { ActionGuard, type Action, type ActionGuardProvider, type GuardVerdict, combineActionGuards } from "./tools/action-guard"
export { type Choice, type StepState, SystemOne } from "./system-one/systemone"
export { type CompactOptions, type Handoff, type Hooks, SystemTwo, type ToolCall } from "./system-two/systemtwo"
export { Ask, AskError } from "./system-two/ask"
export { Fill, FillError } from "./system-two/fill"
export { Store } from "./base/store"
export { CurrentSession, type SessionEntry, type SessionMirrorFn } from "./base/session"
export { withLock } from "./base/files"
export { Channel } from "./base/channel"
export { ActiveAgent, Memory, MemoryError, type Scope } from "./base/memory"
export { recordUsage, type Tokens } from "./base/usage"

// Small helpers every kind of plugin uses: showing what it does (an event: activity, an error), one more try after a
// temporary failure, a Schema as JSON schema (for a provider's structured output), an image the user attached.
export { emit, type Kind } from "./base/events"
export { retryIfTemporary } from "./base/retry"
export { jsonSchemaFor } from "./base/json-schema"
export { loadImage } from "./base/images"

// The tools System Two is given (for a backend to present its own way), one call handled the same for every backend,
// and how System Two is told to use them; the kernel's part names only what it grants (hooks.grants: config.json's
// kernel.tools), the constants being everything granted.
export { callTool, type CallResult, type CallState, type Ended, jobsReminder, newCallState, SYSTEM_TWO_TOOLS, systemTwoTools } from "./system-two/dispatch"
export { KERNEL_INSTRUCTIONS, kernelInstructions } from "./system-two/instructions"
export type { Grants } from "./base/grants"
// For an agent CLI that runs its own loop: the tools served over MCP, answered by callTool.
export { serveTools, type ToolRelay } from "./system-two/relay"
// For a model (one request, one reply): the core runs the request loop around it.
export { type Model, type ModelCall, type ModelReply, type ModelRequest, type ModelTool, systemTwoFromModel } from "./system-two/loop"
export { askFromModel, fillFromModel, modelParts } from "./system-two/structured"
