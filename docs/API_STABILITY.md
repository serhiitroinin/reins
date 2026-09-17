# API stability

Version 0.1.0 starts the supported public API.

## Stable API

Every export in `package.json` is public unless this document marks it as
experimental or test-only. The stable paths include the core runtime, protocol,
discovery, admission, context, tools, persistence contracts, transports,
sidecar, native Claude Code adapter, native Codex adapter, and ACP adapter.

The JSON Schema under `schema/v1` is stable. The generated Rust and Swift types
follow that schema.

The file `api/public-api.json` records every exported TypeScript symbol. The
release check fails when a path or symbol changes. A maintainer must review an
API change and update the file on purpose.

Stable changes are additive. We do not remove or rename a stable path, symbol,
event kind, field, or sidecar method in a patch release. We first add a new
form and document a migration.

## Experimental API

`@serhiitroinin/fold-harness/adapters/opencode-acp` is experimental. It is a
small ACP composition helper. Native OpenCode support is not part of version
0.1.

Experimental API can change in a minor release. The core protocol remains
provider-neutral when that happens.

## Test-only API

`@serhiitroinin/fold-harness/testing` is test-only. It contains fixtures and
conformance runners. Use it in tests and examples. Do not use it as a runtime
provider in a product.

Test-only API can grow with the supported behavior matrix. We avoid needless
breaks, but it does not have the stable API promise.

## Security boundary

The runtime is not a sandbox. A capability reports provider behavior. It does
not grant authority. The host owns credentials, process launch, environment,
filesystem and network policy, application confirmation, and domain writes.

Provider SDK types do not define the core runtime contract. Provider-specific
types stay in their adapter paths.
