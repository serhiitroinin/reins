---
"reins": minor
---

Rename the package to `reins`. Versions up to 0.1.1 were published as
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
