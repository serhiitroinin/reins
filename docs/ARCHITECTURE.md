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

Engine and model discovery may also declare input policy. The engine provides
defaults and a selected model overrides only fields it knows. Support and
limits are separate: an absent modality, maximum, or media-type list means
unknown, never an inferred refusal. Modality identifiers are open so an ACP or
future native adapter can add a shape without provider-name branches in a
host.

## Inline context

`HarnessRunRequest.input` is the canonical ordered composer value. Text,
images, resources, and `context-reference` parts can be interleaved without
parsing Markdown or depending on a web editor. The optional versioned
`inlineContext` table resolves each reference to an open-kind record with a
stable id, label, and bounded JSON payload treated as untrusted provider
content. Unknown kinds survive validation;
malformed envelopes, duplicates, stale references, cycles, and exceeded
bounds fail closed with explicit issues.

An attachment or resource binding points to the id of an ordinary image or
resource input. Bytes and provider resource URIs stay at that input boundary,
not in the context record. This lets a host persist draft references and
attachment metadata without persisting binary payloads in the record table.
The package supplies pure resolution and policy-validation functions, while
the product owns uploads, record lookup, authorization, freshness, storage,
and rendering.

Inline context is user input and is distinct from prepared context sources.
Prepared sources snapshot host-owned domain state and preserve trusted
instructions separately from untrusted content. An adapter's default input
mapper renders a validated inline reference as untrusted provider content;
hosts can replace that mapping when a provider supports a richer native form.

## Runtime

`createHarness` caches one adapter session per tenant, actor, thread, and
adapter. One turn runs in that session at a time. A persisted resume token is
offered when a process opens the session again.

The host supplies event and session stores. The in-memory implementation is a
reference for tests and prototypes; production applications should implement
durable, tenant-scoped stores.

A product that admits and identifies work before calling the runtime can bind
its existing run id, turn id, `AbortController`, and prepared context through
the runtime-only start options. The supplied controller becomes owned by that
run: runtime cancellation aborts it. The supplied context is trusted host
state and is passed by identity to the adapter and tool boundary without being
persisted. These values are not part of `HarnessRunRequest` or its JSON-safe
wire representation.

The same runtime-only options accept a host-resolved `inputPolicy`. The runtime
copies the policy synchronously and validates the initial input before ID
allocation, context preparation, event persistence, or adapter opening.
Same-turn follow-ups reuse that private snapshot. Replacement follow-ups
inherit it unless the host supplies a newly admitted override, which is copied
and validated before the old provider turn is cancelled. The runtime never
derives policy from a provider name or lets an untrusted wire request select
its own constraints; account/catalog lookup and policy composition remain host
responsibilities.

Cancellation changes the terminal status to `interrupted` and asks the
adapter to settle. Events the adapter yields while settling are still durable:
partial text and terminal tool states describe work that already happened and
must precede the runtime-owned `turn-completed` event.

Cancellation has three ordered boundaries: dispatch to the adapter, drain the
provider turn, then persist and close the runtime terminal envelope. A session
remains reserved through all three. External aborts use the same dispatch path,
cancellation failures do not bypass the drain, and a session that finishes
opening after cancellation is closed without running.

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

## Follow-up coordination

The optional turn queue is a framework-neutral host primitive, not a provider
queue and not part of `HarnessRuntime.start`. It orders opaque host snapshots
by the existing tenant, actor, thread, and adapter identity. A host chooses the
safe dispatch boundary and supplies a unique boundary token; the queue leases
at most one entry at that boundary. Held entries block the tail so later user
intent cannot overtake them.

An unsettled lease carries an abort signal. Holding or draining a queue bumps a
monotonic generation, aborts the lease, and makes late completion invalid. The
host must pass that signal through asynchronous preparation, check the lease by
completing it, and begin irreversible dispatch in the same synchronous task.
This closes the common race where Stop drains visible follow-ups while a
previously taken item is still uploading.

The queue is deliberately in-memory and inspects or persists none of its
generic payload. Products decide whether an intent is a transient follow-up, a
durable draft, or a domain record. Provider-native same-turn steering,
replacement turns, and compaction remain separately negotiated lifecycle
features; queueing a message never implies that an adapter can steer.

`HarnessCapabilities.steering` declares `same-turn` and/or
`replacement-turn`; it never declares waiting. `HarnessRun.followUp` requires
the caller's expected active turn id. Same-turn steering reuses the original
run, turn, signal, context, and tool host and sends only the new untrusted
input. It emits no second runtime start or intermediate completion.
Replacement steering validates the fresh input and prepares the fresh turn
context before touching the old provider turn, rechecks active-turn admission,
then crosses the full cancellation, drain, and terminal boundary before
calling `start` with new run and turn ids. A
replacement must not reuse the old run id, turn id, or abort controller. A
failed preparation leaves the original turn alive. Follow-up and Stop
operations are serialized per run, and unknown provider failures become safe
runtime errors.

## Tools

Tools use JSON Schema at the provider boundary and an application-owned
validator before execution. Policy runs before validation and execution. Tool
implementations receive explicit session and turn identity plus an abort
signal.

Provider permission requests and application transaction confirmation are
different interactions. An adapter may ask whether provider execution can
continue; a domain tool may separately hold a proposed write for product
review.

`createHarnessMcpServer` is the portable MCP projection of that boundary. It
captures one trusted `HarnessToolContext`, publishes the host's JSON Schema
catalog, and routes calls back through the same policy and validator. The MCP
caller supplies only a tool name and arguments; it cannot choose the actor,
tenant, turn, context snapshot, or policy.

The server owns bounded newline JSON-RPC framing and the MCP initialize,
ping, cursor-paginated list, concurrency-bounded call, and cancellation
methods. It consumes and emits
`Uint8Array`, so the product can place it behind stdio, a Unix socket, a web
stream, a native bridge, or a remote transport. The product still owns that
transport and all authentication, origin, confidentiality, lifecycle, and
backpressure decisions. In particular, its injected writer must synchronously
accept or queue the complete frame and throw if it cannot; a socket with
partial writes needs a host-owned draining writer. The package imports no
MCP/provider SDK and performs no process, filesystem, environment, credential,
or network access.

Tool descriptor and result metadata remain private instead of becoming MCP
`_meta` implicitly. A product can add an explicit, reviewed projection later
without accidentally exposing application state through a new transport.

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
It also exposes App Server's explicit `turn/steer` request. The complete
adapter keeps the provider turn id private and applies it as
`expectedTurnId`, while the runtime preconditions the public harness turn id.
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

Claude Agent SDK communication uses a host-injected, long-lived connection.
`createClaudeAgentSdkAdapter` starts that connection lazily on its first turn,
routes later turns over the same provider stream, and converts unknown SDK
messages into the same `HarnessAdapterEvent` contract. The public connection,
input, permission, and event types are package-owned structural contracts; no
Anthropic SDK type crosses the adapter boundary.

The adapter normalizes prose, thinking, plans, tool runs, usage, account-limit
updates, compaction, and subagent activity. Claude-only activity uses the
`anthropic:claude-agent-sdk` extension namespace. Tool input and output are
private by default. A host must explicitly select a safe presentation,
redacted output, subagent failure, or compaction failure before any of those
details enter an event. A subagent's provider-owned `skip_transcript` signal is
retained as extension metadata so a product can track the task without drawing
it. Provider failures follow the same explicit public-error rule as Codex.

The injected connection receives application tools and a provider-permission
callback. A host can decide immediately or return a deferred interaction. The
adapter then owns `interaction-requested`, `respond`, and
`interaction-resolved`, while the host still defines the choices and their
meaning. This provider execution permission remains separate from any product
transaction confirmation performed by an application tool.

Interaction durability is deliberately split from callback recovery. The
event log can prove that a request was shown, answered, invalidated, or left
open; it cannot recreate a provider callback after a process exits.
`HarnessInteractionCapability.recovery` therefore declares `live-only` or
`provider-replay`, with an omitted value interpreted as the conservative
`live-only` behavior for older v1 documents. A resume checkpoint does not
change that declaration.

`HarnessInteractionProjector` accepts overlapping replay pages and live events,
deduplicates their envelopes, and derives one FIFO across permission, question,
confirmation, and future interaction kinds. It retains explicit resolved and
invalidated outcomes. A terminal event is final for every unanswered request
on that exact session, adapter, run, and turn, so an older replay page cannot
resurrect a dead control. The runtime writes `interaction-invalidated` before
its terminal seal when an adapter leaves a request open. Invalidation states a
loss of actionability; it is never encoded as a user answer.

An Agent SDK `system/init` message updates only the opaque resume checkpoint.
The optional checkpoint hook is awaited before a turn completes. Interrupts
wait for the provider's terminal boundary so an old result cannot settle the
next turn. A provider that does not reach that boundary within the configured
grace period has its connection retired rather than reused. A rejected turn
send retires the stream immediately too, because provider work may already
have started and its delayed output cannot be attributed to another turn.
Same-turn follow-ups are serialized behind the initial send, contain no repeat
of the prepared application context, and are refused while a provider
interaction is pending.

A long-lived connection is pinned to the account, model, effort, run settings,
and provider configuration from its first turn. A later turn that changes that
identity is refused with a public error instead of being sent through a process
with stale authority. Hosts whose configuration contains turn-only fields can
provide `connectionKey` to select only the connection-scoped portion; account,
model, effort, and run settings remain pinned regardless.

The connection factory still owns the actual SDK query and every option that
can change its authority: explicit environment, account and credentials,
private provider home, working directory, tool allowlist, settings sources,
plugins, hooks, MCP servers, sandbox, and approval rules. The adapter does not
spawn Claude or infer any of them. Application-only context `state` is removed
from the default provider input; only trusted instructions and untrusted
content cross that boundary.

Stable ACP v1 communication uses a host-injected raw byte connection composed
over the official protocol SDK. `createAcpV1Adapter` owns negotiation,
new/load-session lifecycle, prompts, permission round trips, cancellation,
checkpoints, event normalization, and reconnect after process closure. Its
public types remain SDK-free, and the host owns the process, credentials,
environment, roots, MCP servers, and transport implementation.

ACP v1 has no portable active-prompt steer operation. Its declared strategy is
therefore `replacement-turn`: the core runtime prepares the replacement, asks
the adapter to cancel and settle permissions, drains the prompt, seals the old
envelope, retires the transport, and only then reloads the session for the next
prompt. The capability is conditional on negotiated `session/load` support,
because ACP v1 update frames have session identity but no prompt identity. A native OpenCode, Grok, or
future adapter may declare stronger behavior after its own conformance tests;
the ACP label alone never implies it.

Negotiated ACP modes and config options are exposed to a host controller rather
than assigned universal meaning. A Claude mode, Codex collaboration mode, and
OpenCode mode need not represent the same authority. Likewise, live model,
effort, and Fast options complement rather than replace the package's independent
profile, catalog, and account-limit discovery calls. ACP v1 has no complete
portable representation for those product surfaces.

The generic ACP adapter deliberately does not advertise client filesystem or
terminal capabilities. It normalizes agent-reported tool lifecycles, while
application tool execution enters through explicit host-owned MCP servers.
Raw tool/provider data is private unless a host presentation or public-error
hook maps a bounded safe value.

ACP prompts also have no trusted system/instruction role. The default mapper
therefore refuses a turn with prepared application context; a host must choose
an agent-appropriate mapping without silently erasing the trust distinction.
See `docs/ACP_V1.md` for the measured provider matrix and native-adapter decision.

This division is also the stack boundary. The protocol, discovery contracts,
and wire formats do not assume React, Electron, HTTP, or a particular database.
JavaScript hosts can use the runtime directly. Other language and native hosts
can implement the same versioned protocol from the JSON Schema or generated
Swift and Rust data bindings; they do not need to embed Fold's UI or daemon.
The schema describes values rather than selecting HTTP, SSE, WebSocket, Unix
socket, or embedded-bridge transport. Binary images use an explicit canonical
base64 wire representation. Executable callbacks, abort signals, provider SDK
objects, application-only context state, and raw failures stay outside it.

Schema v1 evolves only through compatible optional fields and open identifiers.
Known event kinds retain their required shapes, while an unknown future event
kind remains retainable or safely ignorable. An incompatible field or closed
union change requires a new schema major. Generated bindings are conveniences,
not validators; the JSON Schema remains authoritative at an untrusted boundary.

## Reference host

`examples/incident-terminal` is the first non-Fold reference product. Its UI is
plain terminal input/output, its domain state is an in-memory incident store,
and its provider is a deterministic offline fixture. It consumes the same
runtime surfaces a browser, desktop shell, server, or native bridge would:
discovery, context sources, tools, events, interactions, checkpoints, and
cancellation.

The example keeps provider execution permission and application transaction
confirmation separate. The adapter requests the former through a runtime
interaction. The validated incident tool performs the latter in the host just
before mutation. Neither decision is inferred from the other.

This example does not add a terminal abstraction to the package and does not
claim provider interoperability or sandboxing. It demonstrates that product
state and presentation can change without changing the core runtime. The
native Claude/Codex and ACP adapter suites remain the evidence for provider
behavior.

The current Codex App Server schema accepts dynamic tools on thread creation,
not thread resume. The adapter enables the experimental API capability when a
run exposes a non-empty catalog, and omits an empty catalog so ordinary turns
stay on the stable protocol. A resumed thread therefore keeps its original
catalog. A host must discard a stale checkpoint when its application tool
catalog is no longer compatible.

## Security boundary

The runtime is not an operating-system sandbox. A host must construct explicit
provider environments, protect credentials, scope stores by actor and tenant,
and decide whether tools or subprocesses may access the filesystem or network.
Arbitrary adapter errors are redacted; only `HarnessAdapterError` carries a
message an adapter deliberately marked safe to persist.
Required context failures follow the same rule: only a
`HarnessContextSourceError` can supply public failure text.
