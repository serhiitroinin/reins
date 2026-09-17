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
it wraps the generated values in JSON-RPC envelopes, launches a command over
stdio, negotiates the Fold Harness sidecar, reads capabilities, and shuts it
down. It remains an example rather than a general transport client.

Regenerate both from the repository root:

```bash
bun run generate:bindings
```

The generated sources are included in the npm tarball for the preview series,
but the Rust crate is marked `publish = false` and is not published to
crates.io. A separate native release policy can be introduced after the v1
schema has real consumers.
