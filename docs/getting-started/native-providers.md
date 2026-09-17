# Claude Code and Codex

Version 0.1 supports native Claude Code and Codex sessions.

Both adapters use the same runtime contract. They do not have the same feature
set. Always read discovery data. Do not infer features from the provider name.

## Claude Code

Use these functions:

- `createClaudeAgentSdkAdapter`
- `createClaudeAgentSdkConnector`

The host must pass an exact environment and a closed session configuration.
The configuration controls built-in tools, skills, settings sources, plugins,
permission mode, and the system prompt.

The adapter supports streamed turns, resume checkpoints, interactions,
application tools, cancellation, same-turn steering, limits, and subagent
stop.

## Codex

Use these functions:

- `createCodexAppServerAdapter`
- `createCodexAppServerProcessConnector`

The host must pass the exact command, arguments, environment, working
directory, and thread policy. The package does not choose a sandbox or
approval policy for you.

Codex Fast is a generic control. Read it from the profile. Pass the selected
value in `settings.controls`. Do not add a Codex-only field to your UI state.

## Safe setup order

For each account, use this order:

1. Create an exact provider environment.
2. Create the connector.
3. Create the adapter.
4. Read capabilities, profile, models, and limits.
5. Resolve admission from the selected values.
6. Start the run with the resolved request and admission snapshot.
7. Render streamed events.
8. Route interactions, steering, and cancellation through the run handle.
9. Close the runtime during host shutdown.

Use the package live test before you ship an account configuration. See
[live provider tests](live-tests.md).
