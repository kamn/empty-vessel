# Codex-compatible session recording

When Codex is selected as System Two, new empty-vessel turns automatically write AgentPlayback-compatible JSONL alongside Codex sessions:

```text
${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-empty-vessel-<start>-<session UUID>.jsonl
```

Restart empty-vessel with the updated code, run a turn using Codex, then refresh/rescan AgentPlayback. No AgentPlayback modification is required. If setting `CODEX_HOME`, use the same single directory for empty-vessel and AgentPlayback. This changes the export destination, not where the existing Codex plugin reads its login.

- Records include project/session metadata, human prompts, assistant replies, lightweight activity markers, model names, and actual Codex input/cache/output/reasoning usage. Codex-backed auxiliary calls inside a turn are included; Jev usage is not relabeled as Codex usage.
- Resume appends to the same file. No old history is backfilled. Existing Codex rollouts and login files are untouched. These exports target AgentPlayback, not Codex CLI session resumption.
- Children appear as separate sessions. Their parent ID is retained as `empty_vessel_parent_session_id`; Codex fork markers are intentionally omitted because AgentPlayback otherwise discards independent child usage as replayed history.
- File permissions are `0600` on creation. Prompt/reply text is stored locally; login-file credentials, encrypted reasoning, and raw tool arguments/results are not exported. Write failures warn without failing the turn. Line-change statistics are not exported.

## Verification

The normal tests use temporary directories and fake HTTP. To additionally exercise an existing AgentPlayback checkout's real discovery and parser:

```sh
AGENTPLAYBACK_ROOT=/absolute/path/to/AgentPlayback bun test test/plugins/codex-playback.test.ts
```

The integration suite covers discovery, titles, resume, repeated equal token counts, and independent child usage. Its five tests skip when `AGENTPLAYBACK_ROOT` is unset. Millisecond collisions within one empty-vessel process receive distinct usage timestamps; separate processes can still collide with upstream's global timestamp-based deduplication.
