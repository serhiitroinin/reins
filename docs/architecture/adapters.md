# Adapters

This page is part of [the architecture reference](../ARCHITECTURE.md). It uses
the terms in [the glossary](../GLOSSARY.md).

## The adapter contract

An adapter opens or resumes an engine session. It then exposes an
`AsyncIterable` of normalized events.

Every adapter must obey these rules:

1. State your real capabilities. Do not claim a feature that you cannot
   deliver.
2. Keep engine SDK types out of the core protocol.
3. Observe `HarnessAdapterOpenRequest.signal` while opening.
4. Reject or otherwise settle promptly on abort.
5. Never publish a usable session after retirement.

## Codex

### The App Server client

Codex App Server communication uses a shared newline JSON-RPC peer.

The model mapper exposes App Server reasoning options, modalities, and service
tiers through the generic catalog. Fast is a model-declared service-tier
control. It is not a universal boolean.

A future adapter may group models from several underlying engines. It may add
namespaced controls. Neither change touches the runtime.

The low-level module serializes the initialize, thread, resume, and turn
requests. It builds them only from host-supplied decisions about product
identity, sandbox, approval, model, effort, image handling, and generic
controls.

The module also exposes the explicit `turn/steer` request of App Server. The
complete adapter keeps the engine turn id private and applies it as
`expectedTurnId`. The runtime preconditions the public turn id.

### The event consumer

The turn-scoped event consumer translates App Server notifications into
`HarnessAdapterEvent`, `HarnessLimitSnapshot`, and terminal turn outcomes.

It performs these jobs:

- Reconcile streamed message deltas with the authoritative completed message.
- Track cumulative token baselines per turn.
- Close orphaned tool rows.

Account limits travel through a separate callback. They never masquerade as
turn usage.

Tool presentation and output redaction are host hooks. The default never
serializes MCP arguments. A host can classify its own tools without teaching
the package about its event schema.

Engine failure text is redacted by default. It becomes public only through an
explicit host mapper.

### The complete Codex adapter

`createCodexAppServerAdapter` composes the client and the consumer into the
public runtime contract. It owns the wire lifecycle, dynamic tool round trips,
context trust labels, cancellation, checkpoints, and transport termination.

The checkpoint order is important. After App Server accepts a turn, the adapter
calls the runtime-owned checkpoint writer first. The resumable thread id is
therefore durable before the turn completes or fails.

The optional `onCheckpoint` hook stays available for extra host observation.
Neither callback runs for a refused thread or a refused turn opening. The
adapter awaits asynchronous work, so a failed write cannot be mistaken for a
durable checkpoint.

The connection factory is injected per turn. The process, environment,
credentials, account selection, MCP configuration, sandbox posture, domain
context, and persistence stay host decisions.

### Dynamic tools and resume

The current Codex App Server schema accepts dynamic tools on thread creation.
It does not accept them on thread resume.

The adapter enables the experimental API capability when a run exposes a
non-empty tool catalog. It omits an empty catalog, so an ordinary turn stays on
the stable protocol.

A resumed thread therefore keeps its original catalog. Discard a stale
checkpoint when your tool catalog is no longer compatible with it.

## Claude Code

### The connection

Claude Agent SDK communication uses a host-injected, long-lived connection.

`createClaudeAgentSdkAdapter` starts that connection lazily on its first turn.
It routes later turns over the same stream. It converts an unknown SDK message
into the same `HarnessAdapterEvent` contract.

The public connection, input, permission, and event types are package-owned
structural contracts. No Anthropic SDK type crosses the adapter boundary.

### Normalized activity

The adapter normalizes prose, thinking, plans, tool runs, usage, account-limit
updates, compaction, and subagent activity. Claude-only activity uses the
`anthropic:claude-agent-sdk` extension namespace.

Tool input and tool output are private by default. A host must select one of
these explicitly before the detail enters an event:

- a safe presentation;
- redacted output;
- a subagent failure;
- a compaction failure.

The engine-owned `skip_transcript` signal of a subagent is retained as
extension metadata. A host can therefore track the task without drawing it.

Engine failures follow the same explicit public-error rule as Codex.

### Permission interactions

The injected connection receives the application tools and an
engine-permission callback. A host can decide immediately, or it can return a
deferred interaction.

The adapter then owns `interaction-requested`, `respond`, and
`interaction-resolved`. The host still defines the choices and their meaning.

This engine execution permission stays separate from any product confirmation
that a tool performs.

### Interaction durability

Interaction durability is split from callback recovery. The event log can prove
that a request was shown, answered, invalidated, or left open. It cannot
recreate an engine callback after a process exits.

`HarnessInteractionCapability.recovery` therefore declares one of two values:

| Value | Meaning |
| --- | --- |
| `live-only` | A pending callback dies with the engine process. |
| `provider-replay` | The adapter can enumerate and rebind callbacks after resume. |

An omitted value means `live-only`. That reading is the conservative one, and
it applies to older v1 documents. A resume checkpoint does not change the
declaration.

`HarnessInteractionProjector` accepts overlapping replay pages and live events.
It deduplicates their envelopes and derives one FIFO queue across permission,
question, confirmation, and future interaction kinds.

The projector retains explicit resolved and invalidated outcomes. A terminal
event is final for every unanswered request on that exact session, adapter,
run, and turn. An older replay page therefore cannot resurrect a dead control.

The runtime writes `interaction-invalidated` before its terminal seal when an
adapter leaves a request open. Invalidation states a loss of actionability. It
is never encoded as an answer from a person.

### Connection lifecycle

An Agent SDK `system/init` message updates only the opaque resume checkpoint.
The optional checkpoint hook is awaited before a turn completes.

An interrupt waits for the engine terminal boundary. An old result therefore
cannot settle the next turn. An engine that does not reach that boundary within
the configured grace period has its connection retired rather than reused.

A rejected turn send retires the stream immediately. Engine work may already
have started, and its delayed output cannot be attributed to another turn.

A same-turn follow-up is serialized behind the initial send. It contains no
repeat of the prepared context. It is refused while an engine interaction is
pending.

### Pinned identity

A long-lived connection is pinned to the account, model, effort, run settings,
and engine configuration of its first turn.

A later turn that changes that identity is refused with a public error. The
turn is not sent through a process with stale authority.

A host whose configuration contains turn-only fields can supply
`connectionKey`. That key selects only the connection-scoped portion. The
account, model, effort, and run settings stay pinned regardless.

### The Node.js connector

The injected connection stays available for a custom deployment. The packaged
Node.js connector is its reference implementation. The connector owns the SDK
query, the stream controls, the compaction hook, and the in-process MCP bridge.

Every option that can change authority still comes from the host:

- the explicit environment;
- the account and the credentials;
- the private engine home;
- the working directory;
- the built-in tool list and the skill list;
- the settings sources;
- the plugins;
- the external MCP servers;
- the sandbox;
- the approval rules.

Application-only context `state` is removed before the connector. The default
mapper keeps the trusted instruction label and the untrusted content label
distinct. It does not pretend that a user-role Agent SDK message is a separate
engine system role.

## ACP v1

ACP is the Agent Client Protocol. Stable ACP v1 communication uses a
host-injected raw byte connection composed over the official protocol SDK.

`createAcpV1Adapter` owns these parts:

- negotiation;
- the new-session and load-session lifecycle;
- prompts and permission round trips;
- cancellation and checkpoints;
- event normalization;
- reconnection after process closure.

Its public types stay SDK-free. The host owns the process, the credentials, the
environment, the roots, the MCP servers, and the transport implementation.

### Steering by replacement

ACP v1 has no portable active-prompt steer operation. Its declared strategy is
therefore `replacement-turn`.

The core runtime performs these steps in order:

1. Prepare the replacement.
2. Ask the adapter to cancel and to settle permissions.
3. Drain the prompt.
4. Seal the old envelope.
5. Retire the transport.
6. Reload the session for the next prompt.

The capability is conditional on negotiated `session/load` support. ACP v1
update frames carry session identity but no prompt identity.

A native OpenCode adapter, a Grok adapter, or a future adapter may declare
stronger behavior after its own conformance tests. The ACP label alone never
implies it.

### Modes and controls

A negotiated ACP mode or config option is exposed to a host controller. It is
not assigned a universal meaning. A Claude mode, a Codex collaboration mode,
and an OpenCode mode need not represent the same authority.

Live model, effort, and Fast options complement the independent profile,
catalog, and account-limit discovery calls. They do not replace them. ACP v1
has no complete portable representation for those product surfaces.

### The OpenCode composition helper

The OpenCode ACP helper is optional and experimental. It adds no lifecycle
layer and no policy layer.

It applies only exact negotiated model, effort, and fixed host-mode selections
over `createAcpV1Adapter`. It requires the host to inject the engine profile
that the host can truthfully support.

Process configuration, native-tool denial, credentials, discovery,
capabilities, and sandbox claims stay host concerns.

### Tool and context safety

The generic ACP adapter does not advertise client filesystem or terminal
capabilities. It normalizes agent-reported tool lifecycles. Tool execution
enters through explicit host-owned MCP servers.

Raw tool data and raw engine data stay private. They become public only when a
host presentation hook or public-error hook maps a bounded safe value.

An ACP prompt has no trusted system role and no trusted instruction role. The
default mapper therefore refuses a turn that carries prepared context. Choose
an agent-appropriate mapping instead of erasing the trust distinction.

Read [ACP v1](../ACP_V1.md) for the measured engine matrix and the
native-adapter decision.

## Conformance testing

The public testing package separates two suites:

| Suite | Covers |
| --- | --- |
| Baseline adapter conformance | The common adapter and lifecycle contract |
| Transport reliability conformance | Engine death, malformed traffic, cancellation races, checkpoint rejection |

The native Claude Code and Codex adapters use the reliability suite with
injected fake connections. Those cases pass through the real adapter and the
real runtime. They need no credentials and no process policy.

Every case compares the live event stream with the durable replay. Every case
requires safe terminal sealing.

Real process behavior, authentication, engine versions, and operating-system
behavior stay an explicit live-smoke responsibility. See
[live engine tests](../getting-started/live-tests.md).

## The reference host

`examples/incident-terminal` is a standalone reference product. Its UI is plain
terminal input and output. Its domain state is an in-memory incident store. Its
engine is a deterministic offline fixture.

It consumes the same runtime surfaces that a browser, a desktop shell, a
server, or a native bridge would use. Those surfaces are discovery, context
sources, tools, events, interactions, checkpoints, and cancellation.

The example keeps the two consent boundaries separate. The adapter requests
engine execution permission through a runtime interaction. The validated
incident tool asks for product confirmation in the host, immediately before the
mutation. Neither decision is inferred from the other.

The example adds no terminal abstraction to the package. It claims no engine
interoperability and no sandboxing. It demonstrates that host state and
presentation can change without a change to the core runtime.

The native Claude Code, Codex, and ACP adapter suites remain the evidence for
engine behavior.
