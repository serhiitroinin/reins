# Sidecar and persistence

This page is part of [the architecture reference](../ARCHITECTURE.md). It uses
the terms in [the glossary](../GLOSSARY.md).

## The command boundary

`createHarnessSidecar` wraps the same runtime in a versioned JSON-RPC command
surface.

The sidecar does four things:

1. Perform discovery-driven admission.
2. Call `HarnessRuntime`.
3. Stream the exact persisted `HarnessEvent` values.
4. Delegate tool calls back to the host over a bidirectional request.

The sidecar is not a second runtime. It does not reinterpret engine events.

## Changing a selection

A model, effort, account, permission, or generic control change is an ordinary
new-turn selection.

During an active turn, the same change requires replacement steering. The
sidecar resolves a complete new execution snapshot and a new admission first.
Only then does the runtime prepare context or cancel the current engine turn.

Same-turn steering never changes the frozen execution snapshot.

## What stays outside a command

A native host may supply a JSON-safe prepared context. That context keeps
trusted instructions separate from untrusted content.

Application-only state stays outside the sidecar. Recover it by run identity
and turn identity when the sidecar requests a tool.

These items stay deployment concerns. They are never command fields:

- credentials;
- subprocess launch;
- filesystem and network policy;
- the durable store implementation.

## Transports

The in-process server accepts arbitrary text chunks. It writes through a
synchronous whole-frame writer. Stdio, sockets, native IPC, and test transports
therefore share the same semantics.

The packaged Node.js executable is one deployment above that boundary. It does
these things:

1. Load an explicit adapter host module.
2. Bind bounded stdin and stdout.
3. Supply the private file persistence below.

The executable adds no protocol method. It accepts no credential and no engine
option over the wire.

Read [sidecar protocol v1](../SIDECAR_V1.md) and
`schema/v1/sidecar.schema.json` for the complete specification.

## The private file store

The file store is deployment-specific by design. It is not a new core
assumption.

| Property | Behavior |
| --- | --- |
| Concurrency | One process serializes operations per logical session. |
| Event files | Append-only. Sequences resume after reopen. |
| Checkpoints | Write, then fsync, then rename inside the same directory. |
| Filenames | Logical identities are hashed. |
| Modes | Directories and files are private. |
| Symlinks | Refused, together with any non-regular path. |
| Repair | Only a final event frame that a crash left incomplete is repairable. |
| Corruption in the middle | Fails closed. |

The store implies no cross-process lock, no cloud sync, no database migration,
and no retention policy. A host that needs those supplies another
`HarnessPersistence` implementation.

## The Codex process connector

The Node.js Codex process connector is a deployment primitive. It turns four
host decisions into the byte connection that the Codex adapter consumes:

1. An explicit executable.
2. A complete argument list.
3. An exact environment.
4. An optional working directory.

The connector adds no command flag. It never inherits the parent environment.

Bounded stdout, stderr, and pending stdin protect the host process.
Cancellation owns graceful child termination and forced child termination.

These choices stay with the host:

- a private engine home;
- credentials;
- the sandbox and the approval policy;
- MCP mounts and features;
- the filesystem and network posture.

## The Claude connector

The Node.js Claude connector is the matching Agent SDK primitive. It owns:

- the streaming `query`;
- the input queue;
- the interrupt and subagent controls;
- the compaction callback;
- an in-process MCP server backed by the active `HarnessTurnTools`.

That MCP server lists each host JSON Schema unchanged. It delegates each call
to the turn-scoped tool host. It moves no credential and no domain
implementation into the package.

The connector requires all of the following from the host:

- an exact environment;
- a closed built-in tool list and a closed native-skill list;
- explicit settings sources;
- an explicit permission mode;
- a system prompt;
- `strictMcpConfig: true`.

Additional SDK options use an explicit escape hatch. A connector-owned key in
that escape hatch cannot be replaced.

### The permission callback is not a security claim

The connector does not turn the SDK permission callback into a security claim.

Claude may execute a call that its effective policy already allows, without
invoking that callback.

A host that promises approval must do two things:

1. Install the corresponding ask rules and deny rules.
2. Verify them independently after administrator policy resolves.

`cwd` places relative paths. It confines nothing.

The host still owns all of these:

- the private Claude home and the account environment;
- the sandbox and the built-in tool surface;
- the policy proof;
- the plugins and the external MCP servers;
- public redaction.
