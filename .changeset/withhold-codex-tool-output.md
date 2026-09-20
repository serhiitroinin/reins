---
"reins": minor
---

Behaviour change: Codex tool output is now withheld by default, matching
Claude Code; pass `events.redactToolOutput` to keep it.

Before this release the Codex adapter copied raw command output, MCP results,
and dynamic tool results into `tool-updated` and `tool-completed` events when
the host omitted `redactToolOutput`. It now emits no `outputAppend` unless the
host returns text from `redactToolOutput`. Status, exit code, title, and
`toolOutputMaxChars` truncation are unchanged. The ACP adapter already emitted
output only through `presentTool`.
