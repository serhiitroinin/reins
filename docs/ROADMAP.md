# Roadmap

Reins 0.1 focuses on native Claude Code and Codex sessions. The core
contracts use open provider identifiers. A future adapter can add another
provider without changing the runtime model.

## Released in version 0.1.0

The first stable release includes:

- a provider-neutral runtime and event protocol;
- separate capability, profile, model, permission, control, and limit data;
- streamed turns, tools, interactions, usage, and terminal events;
- resume checkpoints, replay, reset, steering, and cancellation;
- application context with separate trusted and untrusted content;
- application-owned tools with validation and policy;
- native Claude Code and Codex adapters and Node connectors;
- Codex Fast as a generic model control;
- an optional ACP v1 adapter;
- a JSON-RPC sidecar for hosts in any stack;
- JSON Schema and generated Rust and Swift types;
- memory and private file persistence examples;
- a standalone incident terminal example;
- deterministic adapter and reliability conformance tests;
- opt-in live Claude Code and Codex release tests;
- a clean tarball test for Node, TypeScript, Rust, and the sidecar.

## After version 0.1

We will use real host feedback to choose the next work. The likely work is:

1. Keep the native Claude Code and Codex adapters current.
2. Add more small examples for common host and storage choices.
3. Improve sidecar clients when another stack needs a missing helper.
4. Add provider adapters only after they pass the same conformance contract.
5. Prove stable additions in a real host application before we call them
   complete.

OpenCode and Grok provider work is paused. The adapter contract remains open
for them and for other future providers.

## Outside the package

The package will not own these product choices:

- a React or other UI component library;
- one required HTTP, SSE, or WebSocket server;
- product database selection;
- credentials or account storage;
- domain data or domain write policy;
- a universal sandbox claim;
- product-specific confirmation rules.

These choices belong to each harness host.
