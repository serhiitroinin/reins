# JSON Schema protocol v1

Reins publishes its engine-neutral data contracts as JSON Schema 2020-12. A
host can therefore implement a Reins user interface or service without
JavaScript, TypeScript, Electron, or React.

Read [the glossary](GLOSSARY.md) for every term used below.

## What the package contains

| Path | Contents |
| --- | --- |
| `schema/v1/protocol.schema.json` | Events, capabilities, interactions, JSON-safe run requests, typed inline context, and tool data |
| `schema/v1/discovery.schema.json` | Engine profiles, models, permissions, generic controls, input policy, limits, and discovery states |
| `schema/v1/manifest.json` | The stable URI of every supported root |
| `bindings/swift` | Generated Swift `Codable` values |
| `bindings/rust` | Generated Rust Serde values |

The schema documents use JSON Schema draft 2020-12. Their canonical `$id`
values identify contracts. They are not network endpoints. Load the files that
ship in the npm tarball.

## What crosses the boundary

The wire contract carries JSON data only. It excludes these items on purpose:

- engine SDK request and response objects;
- `AbortSignal`, async iterables, callbacks, and executable tool functions;
- engine process creation, environment variables, credentials, and account
  discovery;
- application-only context `state`;
- unredacted engine failures.

## Images

The in-process TypeScript request uses `Uint8Array` for an image. The wire form
uses canonical RFC 4648 base64. It carries `encoding: "base64"` explicitly.

`encodeHarnessRunRequest` and `decodeHarnessRunRequest` bridge the two forms.
They reject any value that ordinary `JSON.stringify` would discard or coerce
without warning. Examples are a cycle, a class instance, and a non-finite
number.

## Inline context

A run request may interleave `context-reference` parts with text, image, and
resource inputs.

The optional `inlineContext` table holds versioned, bounded JSON records only.
A binding names an ordinary image or resource input by id. Image bytes stay as
base64 data on the image input. A resource URI stays on the resource input.

A record kind is an open string. A runtime helper retains a valid unknown kind.
It refuses these inputs:

- a malformed record;
- a duplicate id;
- a stale reference;
- an invalid JSON value;
- an exceeded bound.

## Configuration is an escape hatch

`configuration` is JSON-safe, but it stays adapter-specific. It is not a
portable picker contract.

Use discovery data and `settings` for a model, a permission, an effort value,
or a control whenever you can.

## Steering

Capabilities may include a steering profile. Its closed strategy values are
`same-turn` and `replacement-turn`. Waiting is deliberately absent, because a
host can queue without claiming engine support.

The TypeScript follow-up operation holds live run state and an `AbortSignal`.
It therefore does not cross the JSON wire boundary. A native host reads the
capability data and selects its own transport-specific follow-up operation.

## Interactions

The interaction capability may include `recovery`.

| Value | Meaning |
| --- | --- |
| `live-only` | A pending callback dies with the engine process. |
| `provider-replay` | The adapter can enumerate and rebind callbacks after resume. |
| Omitted | Read it as `live-only`. |

`interaction-invalidated` is a core event. It differs from
`interaction-resolved`. It states that a request can no longer be answered. It
never invents a choice by a person.

The TypeScript interaction projector derives the same terminal finality for an
older event log that predates this event kind.

## Compatibility

Version 1 follows these rules.

Allowed:

- Add a new optional field.
- Add new namespaced extension data.
- Add a future core event kind. It is valid when it has a non-empty `kind`. A
  consumer retains it or ignores it safely. A consumer never reinterprets it as
  a known event.

Unchanged:

- An existing required field keeps its name and its meaning.
- A discriminant keeps its meaning.
- A known event kind must satisfy its complete known shape.
- These identifiers stay open strings: engine, adapter, model, permission,
  effort, control, limit, posture, scope, input modality, context kind, and
  interaction.

Requires protocol v2:

- Removing a field.
- Renaming a field.
- Making an optional field required.
- Changing the meaning of a field.
- Changing a closed union.

The schema is the validation authority. A generated language model is a
convenience binding. It may accept a structural combination that the schema
rejects, such as a discovery `status` paired with the wrong value.

Validate untrusted input against the matching manifest root. Do this at every
process boundary and network boundary.

## Native bindings

The Swift package exposes public `Codable` values such as `FHEvent`,
`FHRunRequest`, and `FHEngineProfile`. The Rust crate exposes the matching
Serde values such as `Event`, `RunRequest`, and `EngineProfile`.

Open identifiers stay strings. An arbitrary JSON extension value retains
arrays, objects, scalars, and null.

Regenerate and verify the checked-in files with pinned quicktype 26:

```bash
bun run generate:bindings
bun run check:bindings
cargo test --locked --manifest-path bindings/rust/Cargo.toml
swift test --package-path bindings/swift
```

### The native source promise is weaker

The JSON compatibility rules above govern the stable wire contract. The
generated native packages are convenience APIs.

A new optional JSON field can add a Swift initializer parameter or a Rust
struct member. Native source code that *creates* these values can then need an
update. Native code that decodes or encodes old JSON stays compatible.

Add a hand-written facade when your product needs a stricter native
source-compatibility promise.

### The shared fixture

Both language tests decode and re-encode the same schema-valid fixture. That
fixture includes:

- a Codex Fast service-tier control;
- an OpenCode multi-engine profile;
- a future context kind with an attachment binding;
- input policies;
- Grok-specific model, limit, and extension identifiers.

The bindings contain no engine SDK and no Reins runtime. They are not yet
published to crates.io or to a Swift registry.

## Transport neutrality

The schemas describe values, not endpoints. A host can carry them over HTTP,
SSE, WebSocket, a Unix socket, an embedded bridge, or another framing protocol.

The NDJSON and JSON-RPC helpers are JavaScript conveniences. They are not a
requirement for a native implementation.
