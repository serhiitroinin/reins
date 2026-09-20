# Documentation

Use this page to choose the smallest guide for your task.

## Start

- [Node quickstart](getting-started/node.md) runs one local streamed turn.
- [Sidecar quickstart](getting-started/sidecar.md) connects another stack over
  standard input and standard output.
- [Rust sidecar example](getting-started/rust.md) uses the generated Rust
  types.
- [Claude Code and Codex](getting-started/native-providers.md) explains native
  engine setup.
- [Live provider tests](getting-started/live-tests.md) verifies a real local
  engine account before a release.

## Guides

- [Build your own app on Reins](guides/build-an-app.md) takes you from a demo
  turn to a shipped product.
- [FAQ](guides/faq.md) answers questions about authentication, cost, provider
  neutrality, and platforms.
- [Glossary](GLOSSARY.md) defines every term this documentation uses.

## Contracts

- [API stability](API_STABILITY.md) defines the supported TypeScript surface.
- [Architecture](ARCHITECTURE.md) defines the ownership boundary and the life
  of one turn.
- [Sidecar protocol v1](SIDECAR_V1.md) defines commands, callbacks, and events.
- [Schema v1](SCHEMA_V1.md) defines JSON and native binding compatibility.
- [ACP v1](ACP_V1.md) defines the optional interoperability adapter.

## Architecture reference

Each page covers one area in full detail.

- [Events and the protocol](architecture/events.md)
- [Discovery and admission](architecture/discovery-and-admission.md)
- [Runtime](architecture/runtime.md)
- [Tools and context](architecture/tools-and-context.md)
- [Adapters](architecture/adapters.md)
- [Sidecar and persistence](architecture/sidecar-and-persistence.md)

## Project

- [Roadmap](ROADMAP.md) states the released scope and the next likely work.
- [Release procedure](RELEASING.md) is the maintainer checklist.
- [Changelog](../CHANGELOG.md) lists released changes.

## Packaged copy

The npm package contains this complete directory. After installation, open
`node_modules/reins/docs/README.md`.

The latest packaged copy is also available through
[unpkg](https://unpkg.com/reins@latest/docs/README.md).
