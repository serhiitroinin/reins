# Rust sidecar example

The package includes generated Rust types and a complete child-process client.
The client covers discovery, tools, interactions, steering, replacement,
cancellation, replay, resume, reset, and shutdown.

## Run the repository example

```sh
bun install
bun run build
bun run smoke:sidecar-native
```

The command builds the Node sidecar. It then starts the sidecar from Rust. The
test uses a deterministic host module and a temporary private store.

## Use the generated crate

The generated crate is in `bindings/rust`. Add it to a workspace by path, or
copy it into your release process.

The client example is here:

```text
bindings/rust/examples/sidecar_client.rs
```

Use generated types for request and response payloads. Keep JSON-RPC framing,
child-process supervision, and application tool execution in your Rust host.

Do not copy provider rules into the Rust client. The sidecar owns those rules.
Your Rust product still owns credentials, product policy, and user interface.
