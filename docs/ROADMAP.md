# Extraction roadmap

The production focus through the prerelease series is the native Claude Agent
SDK and Codex App Server paths. Generic adapter contracts stay open, but new
provider integrations are deferred until those two paths are hardened and
fully dogfooded by Fold.

## Implemented

- Provider-neutral protocol and capability contract.
- Durable-store interfaces and in-memory reference stores.
- Resumable, cancellable runtime with terminal-event sealing.
- Application-owned tool catalog, validation, and policy.
- Turn-scoped context sources with required/optional failure isolation.
- NDJSON, JSON-RPC, and pushable async-input transports.
- Codex App Server lifecycle client.
- Independent engine profile, model catalog, typed control, permission, and limit discovery.
- Portable model selection requirements, lifecycle/availability and context-window metadata,
  catalog freshness, safe discovery codes, and open effort resolution.
- Timestamped account-scoped limit observations kept independent from turn usage.
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
- A thin OpenCode-over-ACP composition helper for exact negotiated model,
  effort, and host-defined mode selection without moving process policy into
  the package.
- A bounded, transport-neutral MCP server over `HarnessToolHost`, with trusted
  turn context captured outside the wire and no provider or operating-system
  dependency.
- Fold's complete workspace context assembled through runtime contributions,
  while vault and product-specific reads remain Fold-owned.
- Fold-owned durable SQLite event and checkpoint stores behind the runtime
  persistence interfaces, with the frozen product projection kept separate.
- A non-Fold incident-triage terminal reference host covering generic
  discovery, context, tools, two consent boundaries, resume, and cancellation.
- A bounded, framework-neutral host follow-up queue with FIFO ordering, held
  intents, explicit dispatch boundaries, and stop-race invalidation.
- Adapter-declared same-turn and replacement steering with expected-turn
  preconditions, serialized Stop/follow-up control, portable cancellation
  dispatch/drain/terminal sealing, native Claude injection, Codex
  `turn/steer`, ACP replacement behavior, and shared conformance coverage.
- Host-resolved input policies enforced by the runtime before initial provider
  work and active-turn mutation, with immutable per-run snapshots and explicit
  replacement overrides.
- Complete runtime-only execution admission covering open adapter/account/model
  selections, effort, resolved permission and generic controls, input policy,
  and stable host session bindings, with inherited or explicitly readmitted
  replacement turns and shared Claude, Codex, and ACP conformance coverage.
- Versioned adapter checkpoint formats, restart-stable host session bindings,
  runtime-owned early checkpoint writes, explicit inactive-session reset, and
  sanitized provider-neutral lifecycle diagnostics.

## Next

1. Harden native Claude and Codex recovery against expired or provider-rejected
   checkpoints, with explicit host policy instead of silent conversation loss.
2. Add portable activity or attention vocabulary only where Claude/Codex hosts
   have a concrete non-Fold consumer and conformance case.

## Deliberately outside the first release

- A React component library.
- A mandatory HTTP or SSE transport.
- A database implementation selected by the package.
- A universal sandbox claim.
- Direct API model loops presented as equivalent to native agent sessions.
- New provider-specific integrations beyond Claude Code and Codex.
