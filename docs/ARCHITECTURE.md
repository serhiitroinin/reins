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

## Engine profiles and discovery

The runtime exposes engine profiles, model catalogs, and account limits as
three independent discovery calls. Their availability can differ and their
refresh cadence usually does too. Discovery failures use explicit safe
messages; raw provider errors are not returned to a product.

An engine profile owns its permission vocabulary. The core does not pretend a
Claude approval policy and a Codex sandbox mode mean the same thing. Permission
modes can require a versioned consent; a stored grant whose version no longer
matches resolves to the safe default. This lets an adapter change the meaning
of an elevated mode without silently reusing old consent.

Common settings are adapter-declared toggle, select, or number controls with
open identifiers and turn, session, or account scope. Models can override the
engine controls where available values differ. Effort remains a first-class
model attribute because its options and default are model-specific, but effort
option ids are still open strings.

Limits are snapshots, separate from per-turn token and cost usage events. A
snapshot can represent rolling rate windows, credits, spend, context, or an
unknown future kind without embedding a provider response type.

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

Codex App Server communication uses a shared newline JSON-RPC peer.
Its model mapper exposes App Server reasoning options, modalities, and service
tiers through the generic catalog. In particular, Fast is a model-declared
service-tier control rather than a universal boolean. OpenCode-style adapters
may group models from multiple underlying providers, and Grok-specific
behavior can be added as namespaced controls without changing the runtime.
The low-level module serializes initialize, thread, resume, and turn requests,
but only from host-supplied product identity, sandbox, approval, model, effort,
image, and generic control decisions.
Its turn-scoped event consumer translates App Server notifications into
`HarnessAdapterEvent`, `HarnessLimitSnapshot`, and terminal turn outcomes. It
reconciles streamed message deltas with the authoritative completed message,
tracks cumulative token baselines per turn, and closes orphaned tool rows.
Account limits travel through a separate callback rather than masquerading as
turn usage. Tool presentation and output redaction are host hooks: the default
never serializes MCP arguments, while a domain product can classify its own
tools without teaching the package about its event schema. Provider failure
text is redacted by default and becomes public only through an explicit host
mapper.
`createCodexAppServerAdapter` composes that client and consumer into the public
runtime contract. It owns the wire lifecycle, dynamic tool round trips,
context trust labels, cancellation, checkpoints, and transport termination.
After App Server accepts a turn, its optional `onCheckpoint` hook lets the host
durably store the resumable thread id before the turn completes or fails. The
hook is never called for a refused thread or turn opening, and an asynchronous
hook is awaited so persistence failures cannot be mistaken for a durable
checkpoint.
Its connection factory is injected per turn. The process, environment,
credentials, account selection, MCP configuration, sandbox posture, domain
context, and persistence remain host decisions.

This division is also the stack boundary. The protocol, discovery contracts,
and wire formats do not assume React, Electron, HTTP, or a particular database.
JavaScript hosts can use the runtime directly. Other language and native hosts
can implement the same versioned protocol from generated bindings once the JSON
Schema milestone lands; they do not need to embed Fold's UI or daemon.

The current Codex App Server schema accepts dynamic tools on thread creation,
not thread resume. A resumed thread therefore keeps its original catalog. A
host must discard a stale checkpoint when its application tool catalog is no
longer compatible.

## Security boundary

The runtime is not an operating-system sandbox. A host must construct explicit
provider environments, protect credentials, scope stores by actor and tenant,
and decide whether tools or subprocesses may access the filesystem or network.
Arbitrary adapter errors are redacted; only `HarnessAdapterError` carries a
message an adapter deliberately marked safe to persist.
Required context failures follow the same rule: only a
`HarnessContextSourceError` can supply public failure text.
