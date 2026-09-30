---
"@serhiitroinin/reins": patch
---

Publish under the scoped name `@serhiitroinin/reins`. npm rejected the
unscoped name `reins` as too similar to `redis`, so 0.2.0 was never published.
This is the first release on npm since the rename.

- Install `@serhiitroinin/reins` and import from `@serhiitroinin/reins` and
  `@serhiitroinin/reins/*`.
- Nothing else changes. The sidecar executable is still `reins-sidecar`, the
  Claude tool prefix is still `mcp__reins__`, and the bindings are still
  `ReinsV1` and `reins-schema`.
