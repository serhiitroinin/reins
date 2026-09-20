# Native schema bindings

These modules are generated data bindings for the public v1 JSON Schema. They
cover sidecar command, notification, and host-tool payloads.

They contain none of the following:

- a JSON-RPC client or a transport;
- an engine SDK;
- a process launcher or credential lookup;
- a tool implementation or a policy;
- application state.

| Directory | Contents |
| --- | --- |
| `swift/` | A Swift package with `Codable` values for native Apple and Swift clients |
| `rust/` | A Cargo crate with `serde` values for native services, command-line tools, and desktop shells |

## The one executable proof

`rust/examples/sidecar_client.rs` is the single executable proof. It wraps the
generated values in JSON-RPC envelopes and launches the Reins sidecar over
stdio.

It exercises the whole command surface:

- discovery and streaming;
- bidirectional tools and interactions;
- same-turn steering and replacement model and settings changes;
- cancellation and replay;
- restart resume, session reset, and shutdown.

It stays an example. It is not a general transport client.

## Regenerate

Run this command from the repository root:

```bash
bun run generate:bindings
```

The generated sources ship inside the npm package. The Rust crate sets
`publish = false`, so it does not go to crates.io. A host can use the crate by
path, or copy the generated files into its own build.

## Compatibility

The v1 JSON wire contract is stable. The generated source API can gain a field
when the schema gains a field.

Read [schema v1](../docs/SCHEMA_V1.md) before you expose these types as your
own public API.
