# API stability

Version 0.1.0 starts the supported public API.

This page uses the terms in [the glossary](GLOSSARY.md).

## Three tiers

| Tier | Paths | Promise |
| --- | --- | --- |
| Stable | Every export in `package.json`, except the paths named below | Additive change only |
| Experimental | `reins/adapters/opencode-acp` | May change in a minor release |
| Test-only | `reins/testing` | May grow with the supported behavior matrix |

## Stable API

The stable paths include the core runtime, protocol, discovery, admission,
context, tools, persistence contracts, transports, and sidecar. They also
include the native Claude Code adapter, the native Codex adapter, and the ACP
adapter.

The JSON Schema under `schema/v1` is stable. The generated Rust and Swift types
follow that schema.

`api/public-api.json` records every exported TypeScript symbol. The release
check fails when a path or a symbol changes. A maintainer must review an API
change and update the file on purpose.

A stable change is additive. We do not remove or rename a stable path, symbol,
event kind, field, or sidecar method in a patch release. We add the new form
first, and we document a migration.

## Experimental API

`reins/adapters/opencode-acp` is a small ACP composition helper. Native
OpenCode support is not part of version 0.1.

The helper can change in a minor release. The core protocol stays
engine-neutral when that happens.

## Test-only API

`reins/testing` contains fixtures and conformance runners. Use it in tests and
examples.

Do not use its scripted adapter as an engine in a product. A development flag
that exposes it is acceptable. A release build must not offer it.

Test-only API can grow with the supported behavior matrix. We avoid a needless
break, but this tier carries no stable promise.

## Security boundary

The runtime is not a sandbox. A capability reports engine behavior. It grants
no authority.

The host owns credentials, process launch, the environment, filesystem and
network policy, product confirmation, and domain writes.

An engine SDK type never defines the core runtime contract. An engine-specific
type stays in its adapter path.

Read [SECURITY.md](../SECURITY.md) and
[the security boundary](ARCHITECTURE.md#security-boundary) for the complete
rules.
