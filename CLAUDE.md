# empty-vessel

A coding agent harness.

## How we work

- Create Git worktrees under `/Users/kamn/Projects/empty-vessel/worktrees/` (the workspace's `worktrees/` directory, not filesystem-root `/worktrees`).

- Explain plainly, with concrete examples over jargon.
- Use clickable Markdown links when referring to a file or web page with a known destination. For local files, use absolute `file://` URLs (percent-encode spaces) so the TUI can open them; for web pages, use HTTPS links.
- Code style: group related lines in a function with blank lines (setup and lookups, the main work, recording and logging, the return), and put blank lines around loops and multi-line `if` blocks. Leave short functions (about 4 lines or fewer) as they are.
- HTML reports and charts (benchmark timelines, comparisons) are local files, written under `local-eval/results/` and opened in the browser. Don't upload or publish them as artifacts.

## Direction

- Runtime: Bun. Any model/provider.
- Effect all the way (not plain async/await).
- Pi's philosophy: minimal core, few simple tools (read, write, edit, bash) that grow over time.
- No permission prompts (YOLO); isolation, if needed, comes from containers.
- **Jev-first (core idea):** Jev (TypeSafe AI's System One model) is at the center of the loop. It picks a known tool or escalates to the LLM (System 2), and curates the LLM's context. The LLM builds reusable tools that grow Jev's options.
- Prime Agent-style sub-agents: the agent writes code that spawns child agents. Children work in their own context; only their results come back to the parent.
- Kernel/Code mode for all effects into the world

## Saved table example

When I ask for an example table, use this small Markdown table to demonstrate the TUI renderer.
Print it directly in the reply, not inside a code block, so table formatting is exercised.
Keep the different cell lengths; they make column alignment easy to inspect.

| Tool | Purpose |
| --- | --- |
| read | Read files |
| write | Save file contents |
| bash | Run commands |
