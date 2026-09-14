# Architecture

Fold Harness separates the concerns a product owns from the wire protocol an
agent provider owns.

```text
product UI and API
        │
        ▼
host context, tools, policy, persistence
        │
        ▼
Fold Harness runtime and event protocol
        │
        ▼
provider adapter
        │
        ▼
ACP agent, native SDK, app server, or direct model loop
```

## Protocol

Events are append-only envelopes. The store assigns a sequence across the
logical session; the runtime assigns run and turn identity. The runtime owns
`turn-started` and `turn-completed`, and seals the stream after the terminal
event. Adapters emit the content between them.

Provider identifiers are strings. Optional behavior is expressed through
capability data, not `if provider === ...` branches. Provider-only information
uses namespaced extension events.

## Runtime

`createHarness` caches one adapter session per tenant, actor, thread, and
adapter. One turn runs in that session at a time. A persisted resume token is
offered when a process opens the session again.

The host supplies event and session stores. The in-memory implementation is a
reference for tests and prototypes; production applications should implement
durable, tenant-scoped stores.

## Context sources

Context sources are application-owned, turn-scoped snapshots. The runtime
prepares them before provider execution and passes the same prepared object to
the adapter and every application tool. This lets a product expose domain
context without putting a vault, mailbox, database, or other product concept
in the harness contract.

Each source explicitly chooses `required` or `optional`. A missing required
source prevents provider execution. A missing optional source is recorded in
the in-memory prepared context and the rest of the turn continues. Applications
classify their own expected availability errors; an unclassified exception is
still a turn failure, so the optional mode cannot silently hide programming
errors. Raw errors can be observed by a host callback but are never persisted
by the runtime.

A normalized contribution keeps trusted, host-authored `instructions` apart
from untrusted domain `content`. Adapters must preserve this distinction when
building provider requests. Opaque `state` is for application tools and is
never written to the harness event or session stores.

## Tools

Tools use JSON Schema at the provider boundary and an application-owned
validator before execution. Policy runs before validation and execution. Tool
implementations receive explicit session and turn identity plus an abort
signal.

Provider permission requests and application transaction confirmation are
different interactions. An adapter may ask whether provider execution can
continue; a domain tool may separately hold a proposed write for product
review.

## Adapters

An adapter opens or resumes a provider session and exposes an `AsyncIterable`
of normalized events. It must state its real capabilities and must not leak
provider SDK types into the core protocol.

Codex App Server communication currently uses a shared newline JSON-RPC peer.
The process, environment, MCP configuration, and sandbox posture remain host
decisions during the first Fold migration.

## Security boundary

The runtime is not an operating-system sandbox. A host must construct explicit
provider environments, protect credentials, scope stores by actor and tenant,
and decide whether tools or subprocesses may access the filesystem or network.
Arbitrary adapter errors are redacted; only `HarnessAdapterError` carries a
message an adapter deliberately marked safe to persist.
Required context failures follow the same rule: only a
`HarnessContextSourceError` can supply public failure text.
