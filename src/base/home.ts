import { cpSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// The central spot for everything empty-vessel keeps, shared by every project: ~/.empty-vessel (sessions, each project's
// library, pool and notes, the config). EMPTY_VESSEL_HOME points it elsewhere, so a test run is isolated from real use.
export const DEFAULT_HOME = join(homedir(), ".empty-vessel")
export const EMPTY_VESSEL_HOME = process.env.EMPTY_VESSEL_HOME || DEFAULT_HOME

// Once, from the project's old name: ~/.daoliu is copied (config, logins, memory, sessions) to the new home, which then
// starts where the old one left off. runtime/ (build kits, unpacked again on demand) stays behind; the old home stays too.
// ponytail: remove once ~/.daoliu is gone from every machine that runs this.
const OLD_HOME = join(homedir(), ".daoliu")
if (!process.env.EMPTY_VESSEL_HOME && !existsSync(DEFAULT_HOME) && existsSync(OLD_HOME))
  cpSync(OLD_HOME, DEFAULT_HOME, { recursive: true, filter: (path) => path !== join(OLD_HOME, "runtime") })
