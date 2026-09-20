# Claude Code and Codex

Version 0.1 supports native Claude Code and Codex sessions.

Both adapters use the same runtime contract. They do not have the same feature
set. Always read discovery data. Do not infer a feature from an engine name.

## Claude Code

Use these functions:

- `createClaudeAgentSdkAdapter`
- `createClaudeAgentSdkConnector`
- `createClaudeAgentSdkDiscovery`

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
- `createCodexAppServerDiscovery`

The host must pass the exact command, arguments, environment, working
directory, and thread policy. The package does not choose a sandbox or
approval policy for you.

Codex Fast is a generic control. Read it from the profile. Pass the selected
value in `settings.controls`. Do not add a Codex-only field to your UI state.

## Live models and limits

Do not write a model list by hand. It goes stale when an engine ships a new model. Create one discovery source for each adapter and pass both of its
functions to the adapter.

```ts
const discovery = createClaudeAgentSdkDiscovery({
  configure: () => ({ cwd: workspace, env: exactEnvironment }),
});
const claude = createClaudeAgentSdkAdapter({
  models: discovery.models,
  limits: discovery.limits,
  connect,
});
```

```ts
const discovery = createCodexAppServerDiscovery({ clientInfo, connect: processConnector });
const codex = createCodexAppServerAdapter({
  clientInfo,
  models: discovery.models,
  limits: discovery.limits,
  thread,
  connect: processConnector,
});
```

A discovery source starts one short engine process. It does not start a
turn, a thread, or a stored session. It grants no tools. It uses only the
environment that you pass.

- Claude answers from `supportedModels()`, `accountInfo()`, and the usage
  request of the Agent SDK. The Agent SDK marks the usage request as
  experimental. When the request is absent, limits come only from turns.
- Codex answers from `model/list` and `account/rateLimits/read`.

Both sources set `fetchedAt`. The model catalog is cached for ten minutes and
the limit snapshot for one minute. Change these times with `modelsTtlMs` and
`limitsTtlMs`. A failed probe is not cached.

A missing command, a timeout, or a signed-out Claude account gives an
`unavailable` result with a safe message. An account without plan limits,
such as an API key, gives an `unsupported` limit result.

Each adapter also records the limits that an engine sends during a turn. It
merges the newer values over the source result by limit id. Call `limits()`
again after a turn to read them. A request without `accountId` reads the
account that reported last. A request with `accountId` reads only that
account.

Use `claudeAgentSdkModelCatalog`, `claudeAgentSdkUsageLimitSnapshot`,
`codexModelCatalog`, and `codexAccountLimitSnapshot` when your host already
owns the engine connection.

## Safe setup order

For each account, use this order:

1. Create an exact engine environment.
2. Create the connector and the discovery source.
3. Create the adapter.
4. Read capabilities, profile, models, and limits.
5. Resolve admission from the selected values.
6. Start the run with the resolved request and admission snapshot.
7. Render streamed events.
8. Route interactions, steering, and cancellation through the run handle.
9. Close the runtime during host shutdown.

Use the package live test before you ship an account configuration. See
[live engine tests](live-tests.md).
