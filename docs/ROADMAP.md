# Extraction roadmap

## Implemented

- Provider-neutral protocol and capability contract.
- Durable-store interfaces and in-memory reference stores.
- Resumable, cancellable runtime with terminal-event sealing.
- Application-owned tool catalog, validation, and policy.
- Turn-scoped context sources with required/optional failure isolation.
- NDJSON, JSON-RPC, and pushable async-input transports.
- Codex App Server lifecycle client.
- Deterministic adapter fixtures and publish checks.
- Fold dogfood integration for shared Claude and Codex communication seams.

## Next

1. Define an adapter conformance suite around recorded provider fixtures.
2. Extract the Fold event projection from provider consumers.
3. Implement an ACP v1 adapter and test Claude, Codex, and OpenCode through it.
4. Decide from measured parity which native adapters remain necessary.
5. Move the generic MCP tool bridge behind `HarnessToolHost`.
6. Migrate Fold's complete context assembly onto runtime contributions.
7. Implement durable Fold stores behind the runtime interfaces.
8. Build a non-Fold domain example with a browser or terminal UI.

## Deliberately outside the first release

- A React component library.
- A mandatory HTTP or SSE transport.
- A database implementation selected by the package.
- A universal sandbox claim.
- Direct API model loops presented as equivalent to native agent sessions.
