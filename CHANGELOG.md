# @serhiitroinin/fold-harness

## 0.1.0

This is the first stable release.

### Runtime

- Add provider-neutral streamed runs and events.
- Add tools, interactions, subagents, usage, steering, and cancellation.
- Add replay, resume checkpoints, session reset, and safe diagnostics.
- Add discovery and admission for models, effort, permissions, controls, input,
  and limits.
- Add trusted instructions and untrusted application context.

### Providers

- Add native Claude Code support through the Claude Agent SDK.
- Add native Codex support through Codex App Server.
- Add Codex Fast as a generic model control.
- Add an optional ACP v1 adapter.
- Keep the adapter contract open for future providers.

### Any-stack use

- Add a JSON-RPC sidecar over standard input and standard output.
- Add application tool callbacks from the sidecar to the host.
- Add JSON Schema and generated Rust and Swift types.
- Add memory and private file persistence implementations.

### Safety and reliability

- Keep credentials, process policy, domain state, and user interface in the
  host.
- Redact provider errors and adapter extension data by default.
- Bound protocol input, output, event data, and durable file records.
- Fix a Codex cancellation race when the process closes before the interrupt
  request.

### Verification

- Add shared adapter and reliability conformance tests.
- Add clean tarball tests for Node, TypeScript, Rust, and the sidecar.
- Add opt-in live tests for Claude Code and Codex.
- Dogfood the runtime in Fold.
