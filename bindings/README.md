# Native schema bindings

These modules are generated data bindings for the public v1 JSON Schema,
including sidecar command, notification, and host-tool payloads. They do not
contain a JSON-RPC client, provider SDK, transport, process launcher,
credential lookup, tool implementation, policy, or application state.

- `swift/` is a Swift Package with `Codable` values for native Apple and Swift
  clients.
- `rust/` is a Cargo crate with `serde` values for native services, CLIs, and
  desktop shells.

`rust/examples/sidecar_client.rs` is intentionally the one executable proof:
it wraps the generated values in JSON-RPC envelopes, launches the Fold Harness
sidecar over stdio, and exercises discovery, streaming, bidirectional tools,
interactions, same-turn steering, replacement model/settings changes,
cancellation, replay, restart resume, session reset, and shutdown. It remains
an example rather than a general transport client.

Regenerate both from the repository root:

```bash
bun run generate:bindings
```

The generated sources are included in the npm package. The Rust crate has
`publish = false`, so it is not published to crates.io. A host can use the
crate by path or copy the generated files into its build process.

The v1 JSON wire contract is stable. The generated source API can gain fields
when the schema gains fields. Read `docs/SCHEMA_V1.md` before you expose these
types as your own public API.
