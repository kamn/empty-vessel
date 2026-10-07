import type { SkillCatalog } from "../base/skills"
import { type Grants, narrow } from "../base/grants"
import { Duration, Effect } from "effect"
import type { AskUser } from "../ui/ask"
import { type Jobs, makeJobs } from "./jobs"
import type { Background } from "../base/background"
import type { Config } from "../base/config"
import type { Agent, AgentError } from "../base/agents"
import type { Fill } from "../system-two/fill"
import type { Reviewer } from "../learning/reviewer"
import type { SessionError, SessionHandle } from "../base/session"
import type { Store } from "../base/store"
import type { Memory } from "../base/memory"
import type { SystemOne } from "../system-one/systemone"
import type { Tokens } from "../base/usage"
import type { SystemTwo } from "../system-two/systemtwo"
import type { Usage } from "../base/usage"

// What a turn and its steps may use: the services, provided once in main.ts.
export type Needs = SystemOne | SystemTwo | Fill | AskUser | Usage | Config | Reviewer | Background | Store | Memory

// One earlier message in this conversation and empty-vessel's answer to it.
export type Exchange = { readonly user: string; readonly answer: string }

// A session's memory. System Two: its whole thread. System One: the last few exchanges, and a line per turn of what it did.
// briefing: the project's instructions (AGENTS.md / CLAUDE.md) and what empty-vessel learned about it, worked out on the first
// turn and kept (so System Two's start stays the same).
// stash: outputs System One hid (shortened or compacted), for more_output. size: the thread's size at its last request (tokens).
export type Conversation = {
  readonly thread: Array<unknown>
  readonly history: Array<Exchange>
  readonly actions: Array<string>
  readonly files: Set<string> // already given to System Two
  readonly stash: Map<string, string>
  readonly jobs: Jobs // sub-agents started from the kernel (spawn), until collected
  readonly tools: Set<string> // library tools System Two handed to System One this session: always in System One's options
  readonly unseen: Array<Exchange> // turns System One answered alone, since System Two last worked: handed to it next time
  readonly remembered: Array<string> // memory changes this turn ("remembered (project): …"), shown to the user at its end
  saved: { thread: number; stash: number } // how much of the thread and stash is in the session file (src/loop/resume.ts)
  briefing?: string
  skills?: SkillCatalog // metadata snapshot; bodies are loaded only on activation
  skillCatalogPending?: boolean // refreshed or lost to compaction/provider handover
  activeSkills?: Record<string, string> // loaded envelopes, persisted separately from prunable outputs
  activeSkillsPending?: boolean // replay loaded instructions after context loss
  explicitSkill?: boolean // host-owned user invocation must reach System Two
  size?: number
  olderCells?: string // a resumed session's cells from before the kernel's rules: told to System Two once (resume.ts)
  agent?: string // the agent this conversation works as (src/answer.ts, pickAgent), recorded in the session
  instructions?: string // the agent this conversation works as: its instructions, after the project's in the briefing
  takeover?: string // System Two changed: what the new one is told once, on its first run (resume.ts, switchConversation)
  backend?: string // the System Two (systemTwo.use) the thread belongs to, as recorded in the session; none in older sessions
}
export const newConversation = (): Conversation => ({ thread: [], history: [], actions: [], files: new Set(), stash: new Map(), jobs: makeJobs(), tools: new Set(), unseen: [], remembered: [], saved: { thread: 0, stash: 0 } })

// A turn's last step wasn't System Two (a step line is "choice → outcome: reply"): what came after its last run is
// news to it, so the turn is handed over on its next escalation. Live (endTurn) and on resume (loadConversation).
export const unseenBySystemTwo = (lastStep: string | undefined) => !lastStep?.startsWith("escalate →")

// What one turn has done so far, shared by its steps (one object instead of a dozen loose variables).
export type TurnState = {
  readonly steps: Array<string> // each step's result line; System One sees the last 3
  readonly did: Array<string> // System One's own actions this turn, e.g. "gather (money.ts)", "check bun test → failed"
  readonly work: Array<string> // System Two's commands and checks and how they went: the review gate's digest
  readonly passed: Array<string> // commands that passed (exit 0, or a check System One passed): the reviewer's evidence
  gathered: string // files System One loaded this turn, for System Two's first prompt
  escalated: number // System Two runs this turn
  told: number // how many steps System Two has already been told about
  answerText: string | undefined // the latest *answer* (System Two's reply, an ask): other steps can't replace it
  systemTwoAnswered: boolean // the last step was System Two answering: it thinks it's done
  offered: { systemOne: ReadonlyArray<string>; systemTwo: ReadonlyArray<string> } // pool tools on trial this turn (src/loop/pool.ts)
  cellsBefore: number // System Two's kernel cells before this turn: the ones after are this turn's (src/loop/adopt.ts)
  turn: number // this turn's number in the session (1 = the first): the record's events for a turn share it
}
export const newTurnState = (): TurnState => ({ steps: [], did: [], work: [], passed: [], gathered: "", escalated: 0, told: 0, answerText: undefined, systemTwoAnswered: false, offered: { systemOne: [], systemTwo: [] }, cellsBefore: 0, turn: 0 })

// What a step did. `answer`: its reply is an answer for the user (other steps can't replace it).
export type StepResult = {
  readonly reply: string
  // Waiting ends the turn for human input, even though the overall goal is unfinished.
  readonly outcome: "ok" | "failed" | "waiting_for_user"
  readonly answer?: boolean
  readonly fromSystemTwo?: boolean // System Two answered: it thinks it's done
  readonly finishedByCheck?: boolean // its finishing check passed: the goal is done
}

// How a sub-agent is started: the kernel's grants narrowed further (`tools`), and the agent it works as, if any, with the
// config that agent gives it (loaded and checked before the job starts: src/loop/kernel.ts). A cell names the agent;
// this is it, loaded.
export type ChildOptions = { readonly tools?: Partial<Grants>; readonly agent?: Agent & { readonly config: Config["Service"] } }

// The config a sub-agent works with: the agent's, if it works as one (its settings over this one's, src/base/agents.ts),
// with the kernel's grants narrowed by this one's and then by spawn's `tools` (src/base/grants.ts): never more than here.
export const childConfig = (config: Config["Service"], { tools, agent }: ChildOptions) => {
  const base = agent?.config ?? config
  return { ...base, kernel: { ...base.kernel, tools: narrow(narrow(config.kernel.tools, agent?.config.kernel.tools), tools) } }
}

// Everything a turn's steps need, looked up once per turn.
export type Ctx = {
  readonly session: SessionHandle
  readonly input: string
  readonly depth: number
  readonly conversation: Conversation
  readonly config: Config["Service"]
  readonly systemOne: SystemOne["Service"]
  readonly systemTwo: SystemTwo["Service"]
  readonly usage: Usage["Service"]
  readonly spawn: (input: string, options?: ChildOptions) => Effect.Effect<string, SessionError | AgentError, Needs> // a sub-agent one level deeper, granted no more than this one
}

export type Step = (ctx: Ctx, state: TurnState) => Effect.Effect<StepResult, SessionError, Needs>


// Run a call to a model, and add its time and tokens to that system's usage.
export const timed = <A extends { readonly tokens: Tokens }, E, R>(ctx: Ctx, who: "systemOne" | "systemTwo" | "fill", call: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const [took, result] = yield* Effect.timed(call)
    const ms = Duration.toMillis(took)
    yield* ctx.usage.add(who, ms, result.tokens)
    return { result, ms }
  })
