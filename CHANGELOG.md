# reins

## 0.2.0

### Minor Changes

- 094acbf: Add live model and limit discovery for the native adapters.

  - Add `createClaudeAgentSdkDiscovery`, `claudeAgentSdkModelCatalog`, and
    `claudeAgentSdkUsageLimitSnapshot`. Claude models, effort levels, and plan
    limits now come from the Agent SDK without a turn.
  - Add `createCodexAppServerDiscovery` and `codexAccountLimitSnapshot`. Codex
    limits now come from `account/rateLimits/read` before the first turn.
  - Read the `unifiedWindows` of a Claude rate limit update. Live updates carry
    no top-level utilization, so the adapter observed no Claude limits before.
    Utilization fractions are now converted to percentages.
  - Merge newer streamed limits over a host limit source instead of hiding them.
  - Answer a limit request without an account id from the account that reported
    last.

- b1914be: Rename the package to `reins`. Versions up to 0.1.1 were published as
  `@serhiitroinin/fold-harness`. This is the first release under the new name.

  Every identifier that carried the old name changes. No compatibility aliases
  exist.

  - Install `reins` and import from `reins` and `reins/*`.
  - The sidecar executable is `reins-sidecar`.
  - The Claude tool server is `reins`, so Claude tool names start with
    `mcp__reins__`. Update allow-lists that used `mcp__fold-harness__`.
  - The redacted extension marker is `reins:redacted`.
  - Tool list cursors start with `reins:v1:`. Cursors from older versions are
    not valid.
  - The default ACP client name and the default sidecar MCP server name are
    `reins`.
  - JSON Schema `$id` values start with
    `https://github.com/serhiitroinin/reins/schema/v1/`.
  - The Swift package and module are `ReinsV1`. The Rust crate is
    `reins-schema` (`reins_schema` in code).
  - The live test variables are `REINS_LIVE` and `REINS_LIVE_*`.

- c124713: Behaviour change: Codex tool output is now withheld by default, matching
  Claude Code; pass `events.redactToolOutput` to keep it.

  Before this release the Codex adapter copied raw command output, MCP results,
  and dynamic tool results into `tool-updated` and `tool-completed` events when
  the host omitted `redactToolOutput`. It now emits no `outputAppend` unless the
  host returns text from `redactToolOutput`. Status, exit code, title, and
  `toolOutputMaxChars` truncation are unchanged. The ACP adapter already emitted
  output only through `presentTool`.

Versions up to 0.1.1 were published as `@serhiitroinin/fold-harness`.

## 0.1.1

- Replace the old prerelease README with a short stable release guide.
- Add one documentation index and one release checklist.
- Check local documentation links during the release gate.

## 0.1.0

This is the first stable release.

### Runtime

- Add provider-neutral streamed runs and events.
- Add tools, interactions, subagents, usage, steering, and cancellation.
- Add replay, resume checkpoints, session reset, and safe diagnostics.
- Add discovery and admission for models, effort, permissions, controls, input,
  and limits.
- Add trusted instructions and untrusted application context.

### Providers

- Add native Claude Code support through the Claude Agent SDK.
- Add native Codex support through Codex App Server.
- Add Codex Fast as a generic model control.
- Add an optional ACP v1 adapter.
- Keep the adapter contract open for future providers.

### Any-stack use

- Add a JSON-RPC sidecar over standard input and standard output.
- Add application tool callbacks from the sidecar to the host.
- Add JSON Schema and generated Rust and Swift types.
- Add memory and private file persistence implementations.

### Safety and reliability

- Keep credentials, process policy, domain state, and user interface in the
  host.
- Redact provider errors and adapter extension data by default.
- Bound protocol input, output, event data, and durable file records.
- Fix a Codex cancellation race when the process closes before the interrupt
  request.

### Verification

- Add shared adapter and reliability conformance tests.
- Add clean tarball tests for Node, TypeScript, Rust, and the sidecar.
- Add opt-in live tests for Claude Code and Codex.
- Dogfood the runtime in a host application.
