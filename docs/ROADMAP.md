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
- Fold dogfood integration for shared Claude and Codex communication seams.

## Next

1. Publish versioned JSON Schema for protocol and discovery contracts, then generate native-language bindings.
2. Make the Codex and Claude fake-provider adapters pass the conformance runner.
3. Extract the Fold event projection from provider consumers.
4. Implement an ACP v1 adapter and test Claude, Codex, OpenCode, and a Grok-backed provider through it.
5. Decide from measured parity which native adapters remain necessary.
6. Move the generic MCP tool bridge behind `HarnessToolHost`.
7. Migrate Fold's complete context assembly onto runtime contributions.
8. Implement durable Fold stores behind the runtime interfaces.
9. Build a non-Fold domain example with a browser, terminal, or native UI.

## Deliberately outside the first release

- A React component library.
- A mandatory HTTP or SSE transport.
- A database implementation selected by the package.
- A universal sandbox claim.
- Direct API model loops presented as equivalent to native agent sessions.
