// The core's version (src/core.ts re-exports it): what core-api.txt was written for. scripts/core-api.ts --write says
// when a change needs it bumped, and refuses until it is; outside plugins say which they work with (a range).
// Experimental: 0.0.x, every API change bumps the patch (reset from 0.14.0 on 2026-10-06).
export const CORE_VERSION = "0.0.2"
