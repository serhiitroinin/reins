# JSON Schema protocol v1

Fold Harness publishes its provider-neutral data contracts as JSON Schema
2020-12 so a product does not need JavaScript, TypeScript, Electron, React, or
Fold's daemon to implement a harness UI or service.

The package contains:

- `schema/v1/protocol.schema.json` for events, capabilities, interactions,
  JSON-safe run requests, typed inline context, and application tool data;
- `schema/v1/discovery.schema.json` for engine profiles, models, permissions,
  generic controls, input policy, limits, and discovery states;
- `schema/v1/manifest.json` for the stable URI of every supported root;
- `bindings/swift` and `bindings/rust` as generated data-model consumers.

The schema documents use JSON Schema draft 2020-12. Their canonical `$id`
values identify contracts; consumers should load the files shipped in the npm
tarball rather than expect those identifiers to be network endpoints.

## What crosses the boundary

The wire contract includes only JSON data. It deliberately excludes:

- provider SDK request and response objects;
- `AbortSignal`, async iterables, callbacks, and executable tool functions;
- provider process creation, environment variables, credentials, and account
  discovery;
- application-only context `state` and unredacted provider failures.

The in-process TypeScript request uses `Uint8Array` for an image. Its wire form
uses canonical RFC 4648 base64 and carries `encoding: "base64"` explicitly.
`encodeHarnessRunRequest` and `decodeHarnessRunRequest` bridge those forms.
They reject cycles, class instances, non-finite numbers, and other values that
ordinary `JSON.stringify` would silently discard or coerce.

A run request may interleave `context-reference` with text, image, and
resource inputs. Its optional `inlineContext` table contains only versioned,
bounded JSON records. A binding names an ordinary image or resource input by
id; image bytes remain base64 data on the image input and resource URIs remain
on the resource input. The record kind is an open string. Runtime helpers
retain valid unknown kinds while refusing malformed records, duplicate ids,
stale references, invalid JSON values, and exceeded bounds.

`configuration` is JSON-safe but remains an adapter-specific escape hatch. It
is not a portable picker contract. Models, permissions, effort, and controls
should use discovery data and `settings` whenever possible.

Capabilities may include an optional steering profile. Its closed strategy
values are `same-turn` and `replacement-turn`; waiting is deliberately absent
because a host can queue without claiming provider support. The TypeScript
runtime follow-up operation contains live run state and an `AbortSignal`, so it
does not cross the JSON wire boundary. Native hosts use the capability data to
select their own transport-specific follow-up operation.

The interaction capability may include `recovery`. `live-only` means pending
callbacks die with the provider process; `provider-replay` means the adapter
can enumerate and rebind them after resume. Omission means `live-only`.
`interaction-invalidated` is a core event distinct from
`interaction-resolved`: it says the request can no longer be answered and does
not invent a choice by the user. The TypeScript interaction projector derives
the same terminal finality for older event logs that predate this event kind.

## Compatibility

Version 1 follows these rules:

- Existing required fields, discriminants, and meanings do not change.
- New optional fields and new namespaced extension data may be added.
- Provider, adapter, model, permission, effort, control, limit, posture, scope,
  input modality, context kind, and interaction identifiers remain open
  strings.
- A future core event kind is valid when it has a non-empty `kind`. Consumers
  retain it or ignore it safely; they do not reinterpret it as a known event.
- A known event kind must satisfy its complete known shape.
- Removing or renaming a field, making an optional field required, changing a
  field's meaning, or changing a closed union requires protocol v2.

The schema is the validation authority. Generated language models are
convenience bindings and may accept a structural combination that the schema
rejects, such as a discovery `status` paired with the wrong value. Validate
untrusted input against the corresponding manifest root at a process or
network boundary.

## Native bindings

The Swift package exposes public `Codable` values such as `FHEvent`,
`FHRunRequest`, and `FHEngineProfile`. The Rust crate exposes the corresponding
Serde values such as `Event`, `RunRequest`, and `EngineProfile`. Open
identifiers remain strings, and arbitrary JSON extension values retain arrays,
objects, scalars, and null.

The checked-in files are generated with pinned quicktype 26:

```bash
bun run generate:bindings
bun run check:bindings
cargo test --locked --manifest-path bindings/rust/Cargo.toml
swift test --package-path bindings/swift
```

The JSON compatibility rules above govern the stable wire contract. The
generated native packages are convenience APIs and remain prerelease in 0.x:
quicktype models every newly added optional JSON field as a new Swift
initializer parameter or Rust struct member, so regenerating against an
additive schema release can require native source callers to update
initializer calls or struct literals. Decoding and encoding older JSON remain
compatible. Stable native releases will add hand-maintained compatibility
facades before making source-compatibility guarantees.

Both language tests decode and re-encode the same schema-valid fixture. That
fixture includes a Codex Fast service-tier control, an OpenCode multi-provider
profile, a future context kind with an attachment binding, input policies, and
Grok-specific model, limit, and extension identifiers. The
bindings contain no provider SDK or harness runtime and are not yet published
to crates.io or a Swift registry.

## Transport neutrality

The schemas describe values, not endpoints. A host can carry them over HTTP,
SSE, WebSocket, a Unix socket, an embedded bridge, or another framing protocol.
The existing NDJSON and JSON-RPC helpers are JavaScript conveniences, not a
requirement imposed on native implementations.
