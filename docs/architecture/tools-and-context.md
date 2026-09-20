# Tools and context

This page is part of [the architecture reference](../ARCHITECTURE.md). It uses
the terms in [the glossary](../GLOSSARY.md).

## The tool boundary

A tool uses JSON Schema at the engine boundary. It uses an application-owned
validator before execution.

The order is fixed:

1. Policy runs first.
2. Validation runs next.
3. Execution runs last.

A tool implementation receives explicit session identity, explicit turn
identity, and an abort signal.

## Two kinds of consent

Engine permission and product confirmation are different interactions. Do not
combine them.

| Interaction | Question | Who asks |
| --- | --- | --- |
| Engine permission | May engine execution continue? | The adapter |
| Product confirmation | May this domain write happen? | Your tool implementation |

A domain tool can hold a proposed write for product review while the engine
turn stays alive.

## The MCP projection

MCP is the Model Context Protocol. `createHarnessMcpServer` is the portable MCP
projection of the tool boundary.

The server does the following:

1. Capture one trusted `HarnessToolContext`.
2. Publish the host's JSON Schema catalog.
3. Route each call back through the same policy and validator.

An MCP caller supplies only a tool name and arguments. It cannot choose the
actor, the tenant, the turn, the context snapshot, or the policy.

The server owns bounded newline JSON-RPC framing. It owns the MCP initialize,
ping, cursor-paginated list, concurrency-bounded call, and cancellation
methods.

The server consumes and emits `Uint8Array`. You can therefore place it behind
stdio, a Unix socket, a web stream, a native bridge, or a remote transport.

You still own that transport. You own authentication, origin checks,
confidentiality, lifecycle, and backpressure.

Your injected writer must accept or queue the complete frame synchronously. It
must throw when it cannot. A socket with partial writes needs a host-owned
draining writer.

The package imports no MCP SDK and no engine SDK. It performs no process,
filesystem, environment, credential, or network access.

## Private metadata

Tool descriptor metadata and tool result metadata stay private. They do not
become MCP `_meta` implicitly.

You can add an explicit, reviewed projection later. This rule prevents
accidental exposure of host state through a new transport.

## Context sources

A context source is a host-owned, turn-scoped snapshot. The runtime prepares
every source before engine execution. It passes the same prepared object to the
adapter and to every tool.

You can therefore expose domain context to an engine without changing the Reins
contract. A vault, a mailbox, a database, and every other host concept stay out
of the contract.

### Required and optional sources

Each source chooses `required` or `optional`.

| Mode | A missing source causes |
| --- | --- |
| `required` | Engine execution does not start. |
| `optional` | The prepared context records the gap. The turn continues. |

Classify your own expected availability errors. An unclassified exception is
still a turn failure. The optional mode therefore cannot hide a programming
error.

A host callback can observe a raw error. The runtime never persists one.

### Trusted and untrusted parts

A normalized contribution keeps two parts apart:

- `instructions` is trusted and host-authored.
- `content` is untrusted domain data.

An adapter must preserve this distinction when it builds an engine request.

Opaque `state` is for tools only. The runtime never writes it to the event
store or to the session store.
