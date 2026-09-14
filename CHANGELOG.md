# @serhiitroinin/fold-harness

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
