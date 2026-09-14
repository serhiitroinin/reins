# @serhiitroinin/fold-harness

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
