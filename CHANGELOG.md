# @serhiitroinin/fold-harness

## 0.1.0-next.22

### Patch Changes

- 939481d: Enforce an optional host-resolved input policy at runtime admission, snapshot
  it per run, and reject invalid initial or active-turn input before provider
  state changes.

## 0.1.0-next.21

### Minor Changes

- 02234a1: Add portable typed inline-context references, byte-free attachment/resource bindings, open input capability policy, pure validation/resolution helpers, and matching JSON Schema plus Swift/Rust bindings.

## 0.1.0-next.20

### Minor Changes

- 04fe5bb: Add typed interaction recovery capabilities, explicit invalidation events, a replay-safe pending-interaction projector, and consistent stale-response errors.

## 0.1.0-next.19

### Minor Changes

- 0802c6e: Add provider-declared active-turn follow-ups with same-turn and replacement
  strategies, expected-turn preconditions, serialized cancellation/drain
  boundaries, native Claude message injection, Codex `turn/steer`, ACP
  replacement behavior, portable capability schema updates, and conformance
  coverage.

## 0.1.0-next.18

### Minor Changes

- b8c41d5: Add a bounded, framework-neutral follow-up queue with held entries, explicit
  dispatch leases, and generation-safe stop/drain behavior.

## 0.1.0-next.17

### Patch Changes

- 1ebe32e: Add a non-Fold incident-triage terminal reference host covering discovery,
  domain context, validated tools, separate consent boundaries, resume, and
  cancellation.

## 0.1.0-next.16

### Patch Changes

- 777efb8: Retain normalized events yielded by an adapter while a cancelled turn settles.

## 0.1.0-next.15

### Patch Changes

- 90be086: Allow an already-admitted host turn to bind its run and turn identifiers,
  AbortController, and prepared context to the runtime while preserving exact
  identity at adapter and tool boundaries.

## 0.1.0-next.14

### Patch Changes

- 3178516: Enable the Codex App Server experimental capability when a turn includes additional context.

## 0.1.0-next.13

### Patch Changes

- 36176fb: Expose a bounded, byte-transport-neutral MCP server over `HarnessToolHost`,
  with trusted turn context captured outside the wire and safe tool-result
  projection.

## 0.1.0-next.12

### Patch Changes

- 262518c: Add a stable ACP v1 adapter with host-injected transport, capability negotiation,
  session configuration, permissions, normalized events, cancellation, resume,
  safe presentation boundaries, conformance fixtures, and a live compatibility runner.

## 0.1.0-next.11

### Patch Changes

- f8fd308: Publish immutable JSON Schema 2020-12 documents for the v1 protocol and
  discovery contracts, plus JSON-safe run request encoding with canonical base64
  images for native and non-JavaScript hosts.

## 0.1.0-next.10

### Patch Changes

- 21981dd: Preserve Claude hidden-subagent metadata and add an opt-in compaction error redactor.

## 0.1.0-next.9

### Patch Changes

- 094e7da: Add a conformant, provider-injected Claude Agent SDK adapter with normalized
  events, deferred interactions, application tools, cancellation boundaries,
  subagent extensions, separate account limits, connection-identity pinning, and
  awaited resume checkpoints. Tool data, subagent failures, and provider errors
  remain private unless the host explicitly maps a safe representation.

## 0.1.0-next.8

### Patch Changes

- 9e65953: Negotiate Codex's experimental API only when dynamic tools are exposed, and omit an empty dynamic tool catalog so standard App Server sessions are accepted.

## 0.1.0-next.7

### Patch Changes

- d9917ba: Add a Codex adapter checkpoint callback that hosts can durably persist as soon
  as App Server accepts a turn.

## 0.1.0-next.6

### Patch Changes

- cf3ace1: Add a complete provider-injected Codex App Server adapter with normalized
  lifecycle events, model effort and Fast controls, context trust labels, dynamic
  application tools, cancellation, resume checkpoints, and safe error semantics.

## 0.1.0-next.5

### Patch Changes

- fd9b630: Add a stateful Codex App Server event consumer that emits provider-neutral
  assistant, reasoning, plan, tool, usage, limit, error, and turn-outcome
  contracts with host-controlled presentation and redaction.

## 0.1.0-next.4

### Patch Changes

- Add a framework-neutral adapter conformance runner with deterministic provider fixtures and timeout cleanup.
- Preserve safe runtime errors such as `SESSION_BUSY`.
- Move Codex App Server initialize, thread, resume, and turn request builders behind the adapter boundary.

## 0.1.0-next.3

### Patch Changes

- f6e9e4d: Map Codex account model caches into the generic catalog, including model-specific Fast service tiers.

## 0.1.0-next.2

### Patch Changes

- c155b79: Expose provider-neutral engine profiles, model catalogs, typed controls, permission grants, and account limits. Add Codex model discovery mapping with per-model Fast service-tier support.

## 0.1.0-next.1

### Patch Changes

- 8c53d03: Add turn-scoped context sources with explicit required or optional failure
  handling, safe diagnostics, synchronous preparation for existing hosts, and a
  shared prepared snapshot for adapters and tools.
