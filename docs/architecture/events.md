# Events and the protocol

This page is part of [the architecture reference](../ARCHITECTURE.md). It uses
the terms in [the glossary](../GLOSSARY.md).

## Event envelopes

Events are append-only envelopes.

| Value | Owner |
| --- | --- |
| Sequence number | The store, across the whole session |
| Run id and turn id | The runtime |
| `turn-started` and `turn-completed` | The runtime |
| Every event between them | The adapter |

The runtime seals the stream after the terminal event. No event can follow it.

## Append before publish

The runtime appends an event before it publishes the event. The public async
stream receives the value that the store returned. Live state and replay
therefore agree about redaction and truncation.

Direct use of your own event store is not a runtime operation. It does not
inherit this projection.

## Extension projection

An adapter can attach extension data. That data is not durable merely because
the adapter emitted it.

Follow this sequence:

1. The adapter selects an explicit safe representation of the extension data.
2. The runtime accepts only detached JSON.
3. The runtime enforces fixed limits on UTF-8 byte size, depth, string length,
   and collection size.

Three outcomes are possible for unsafe data:

| Input | Result |
| --- | --- |
| An unapproved or unsafe top-level payload | A fixed redaction marker. No prefix is retained. |
| An unsafe tool extension map | The map is removed. |
| An invalid extension envelope | The envelope is ignored. |

Each outcome produces one sanitized process-local diagnostic. Nothing else
leaves the process.

## Engine identity in events

Engine identifiers are strings. Express optional behavior through capability
data. Do not branch on an engine name. Put engine-only information in a
namespaced extension event.

## The wire boundary

The protocol, the discovery contracts, and the wire formats assume no
framework. They do not assume React, Electron, HTTP, or a database.

- A JavaScript host uses the runtime directly.
- Another language or a native host implements the same versioned protocol.
  It reads the JSON Schema or the generated Swift and Rust bindings. It does
  not embed a JavaScript runtime.

The schema describes values. It does not select a transport. HTTP, SSE,
WebSocket, a Unix socket, and an embedded bridge are all valid.

A binary image uses an explicit canonical base64 wire representation.

These values stay outside the wire boundary:

- executable callbacks;
- abort signals;
- engine SDK objects;
- application-only context `state`;
- raw failures.

## Schema v1 evolution

Schema v1 evolves in two ways only: compatible optional fields, and open
identifiers.

- A known event kind keeps its required shape.
- An unknown future event kind stays retainable or safely ignorable.
- An incompatible field change requires a new schema major version.
- A closed union change requires a new schema major version.

Generated bindings are conveniences, not validators. The JSON Schema remains
authoritative at an untrusted boundary. Read [schema v1](../SCHEMA_V1.md) for
the complete compatibility rules.
