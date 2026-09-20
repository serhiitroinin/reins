# Roadmap

Reins 0.1 focuses on native Claude Code and Codex sessions.

The core contracts use open engine identifiers. A future adapter can therefore
add another engine without a change to the runtime model.

This page uses the terms in [the glossary](GLOSSARY.md).

## Released in version 0.1.0

The first stable release includes:

- an engine-neutral runtime and event protocol;
- separate capability, profile, model, permission, control, and limit data;
- streamed turns, tools, interactions, usage, and terminal events;
- resume checkpoints, replay, reset, steering, and cancellation;
- context with separate trusted and untrusted parts;
- host-owned tools with validation and policy;
- native Claude Code and Codex adapters, and their Node.js connectors;
- Codex Fast as a generic model control;
- an optional ACP v1 adapter;
- a JSON-RPC sidecar for a host in any stack;
- JSON Schema and generated Rust and Swift types;
- memory and private file persistence examples;
- a standalone incident terminal example;
- deterministic adapter and reliability conformance tests;
- opt-in live Claude Code and Codex release tests;
- a clean tarball test for Node.js, TypeScript, Rust, and the sidecar.

## After version 0.1

Real host feedback chooses the next work. The likely work is:

1. Keep the native Claude Code and Codex adapters current.
2. Add more small examples for common host and storage choices.
3. Improve the sidecar clients when another stack needs a missing helper.
4. Add an engine adapter only after it passes the same conformance contract.
5. Prove a stable addition in a real host application before we call it
   complete.

OpenCode and Grok work is paused. The adapter contract stays open for them and
for other future engines.

## Outside the package

The package will not own these product choices:

- a React component library, or any other UI library;
- one required HTTP, SSE, or WebSocket server;
- the product database;
- credentials or account storage;
- domain data or domain write policy;
- a universal sandbox claim;
- product-specific confirmation rules.

Each choice belongs to the host.
