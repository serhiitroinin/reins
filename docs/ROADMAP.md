# Extraction roadmap

## Implemented

- Provider-neutral protocol and capability contract.
- Durable-store interfaces and in-memory reference stores.
- Resumable, cancellable runtime with terminal-event sealing.
- Application-owned tool catalog, validation, and policy.
- Turn-scoped context sources with required/optional failure isolation.
- NDJSON, JSON-RPC, and pushable async-input transports.
- Codex App Server lifecycle client.
- Independent engine profile, model catalog, typed control, permission, and limit discovery.
- Codex model mapping, including model-specific reasoning and Fast service-tier controls.
- Deterministic adapter fixtures, a framework-neutral conformance runner, and publish checks.
- Codex App Server request builders for initialize, thread start/resume, and turns.
- Codex App Server event normalization, including tool lifecycles, turn usage, and separate account-limit snapshots.
- A provider-injected Codex App Server adapter covering transport lifecycle,
  context trust labels, dynamic tools, cancellation, checkpoints, and safe
  terminal semantics, verified through the shared conformance runner.
- Fold dogfood integration for shared Claude and Codex communication seams.
- Fold's Codex App Server lane consuming the complete package adapter.
- A provider-injected Claude Agent SDK adapter covering long-lived stream
  routing, provider interactions, normalized events, cancellation, checkpoints,
  subagents, and separate limit snapshots through the conformance runner.
- Fold's Claude session lane consuming the complete package adapter while Fold
  retains its process policy and frozen product projection.
- Versioned JSON Schema 2020-12 protocol and discovery contracts with a
  JSON-safe request codec and generated Swift and Rust data bindings.

## Next

1. Implement an ACP v1 adapter and test Claude, Codex, OpenCode, and a Grok-backed provider through it.
2. Decide from measured parity which native adapters remain necessary.
3. Move the generic MCP tool bridge behind `HarnessToolHost`.
4. Migrate Fold's complete context assembly onto runtime contributions.
5. Implement durable Fold stores behind the runtime interfaces.
6. Build a non-Fold domain example with a browser, terminal, or native UI.

## Deliberately outside the first release

- A React component library.
- A mandatory HTTP or SSE transport.
- A database implementation selected by the package.
- A universal sandbox claim.
- Direct API model loops presented as equivalent to native agent sessions.
