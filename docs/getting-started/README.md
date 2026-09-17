# Start here

Fold Harness has two ways to run.

- Use the Node API when your host runs JavaScript or TypeScript.
- Use the sidecar when your host uses another language or process.

Choose one guide:

1. [Node quickstart](node.md)
2. [Sidecar quickstart](sidecar.md)
3. [Rust sidecar example](rust.md)
4. [Claude Code and Codex](native-providers.md)

The first example uses a local test adapter. It needs no account or network.
This lets you learn the runtime before you add a provider.

## What the package owns

The package owns the common agent session behavior. It owns run identity,
streamed events, interactions, steering, cancellation, replay, and resume
checkpoints.

## What your product owns

Your product owns credentials, process policy, application tools, domain data,
storage choice, and the user interface. The package is not a sandbox.

Read [API stability](../API_STABILITY.md) before you publish a product.
Read [architecture](../ARCHITECTURE.md) for the full ownership boundary.
