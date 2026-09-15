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
- A stable ACP v1 adapter with host-injected byte transport, negotiated optional
  behavior, live session controls, exact permission round trips, bounded safe
  presentation, cancellation, reconnect, and conformance coverage.
- Live ACP verification against Claude Agent ACP, Codex ACP (including Fast),
  and OpenCode across repeated turns and fresh-process resume.
- A measured adapter strategy: retain native Claude/Codex adapters for enhanced
  provider behavior and use ACP as the generic interoperability path.
- A bounded, transport-neutral MCP server over `HarnessToolHost`, with trusted
  turn context captured outside the wire and no provider or operating-system
  dependency.

## Next

1. Migrate Fold's complete context assembly onto runtime contributions.
2. Implement durable Fold stores behind the runtime interfaces.
3. Build a non-Fold domain example with a browser, terminal, or native UI.
4. Verify Grok's ACP command/auth/cancel/resume behavior when a local binary and
   test credential are available; keep it experimental until then.

## Deliberately outside the first release

- A React component library.
- A mandatory HTTP or SSE transport.
- A database implementation selected by the package.
- A universal sandbox claim.
- Direct API model loops presented as equivalent to native agent sessions.
