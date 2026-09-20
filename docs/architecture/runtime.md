# Runtime

This page is part of [the architecture reference](../ARCHITECTURE.md). It uses
the terms in [the glossary](../GLOSSARY.md).

## Sessions

`createHarness` caches one adapter session per tenant, actor, thread, and
adapter. One turn runs in that session at a time.

A persisted resume token is offered when a process opens the session again.
The runtime offers it only through a versioned checkpoint envelope whose
adapter-owned format is declared compatible.

The host supplies the event store and the session store. The in-memory
implementation is a reference for tests and prototypes. A production host
implements durable, tenant-scoped stores.

## Runtime-only start options

A host that admits and identifies work before it calls the runtime can bind
these values through the runtime-only start options:

- an existing run id;
- an existing turn id;
- an `AbortController`;
- a prepared context.

The run owns the supplied controller. Runtime cancellation aborts it.

The supplied context is trusted host state. The runtime passes it by identity
to the adapter and to the tool boundary. The runtime does not persist it.

These values are not part of `HarnessRunRequest`. They are not part of its
JSON-safe wire representation.

## The admission snapshot

The same runtime-only options accept a `HarnessAdmission`. The snapshot is
optional, and you can adopt it incrementally.

It pins these items:

- the selected adapter and account;
- the model and the effort;
- the resolved permission grant;
- the exact generic controls;
- the input policy;
- an opaque host session-binding fingerprint.

A nullable selection pin uses `null`. The value distinguishes an admitted
absence from an unenforced field.

Controls stay open typed identifiers. Codex Fast, service tier, and future
engine settings therefore need no core engine branch.

### Order of validation

The runtime copies the admission synchronously. It validates every supplied pin
and the input policy before all of the following:

1. ID allocation.
2. Context preparation.
3. Event persistence.
4. Session reservation.
5. Adapter opening.

A non-empty session binding stays stable for the logical runtime session. A
later admitted turn therefore cannot silently change host-owned connection
authority.

The runtime stores the non-secret fingerprint beside a resumable checkpoint and
enforces it after a restart. It does not persist the admitted account, the
settings, the policy, or the other inputs.

A start that omits admission keeps the pre-admission behavior. The legacy
top-level input-policy option is folded into the private snapshot for
compatibility.

### Admission and follow-ups

- A same-turn follow-up reuses the private admission.
- A replacement follow-up inherits the admission unless you supply a new
  snapshot. A new snapshot replaces the old one. It does not merge with it.
- Runtime-only `replacement.execution` can replace the account, model, effort,
  settings, and engine configuration.
- The presence of `replacement.execution` requires explicit readmission.
- An omitted execution field is cleared. It is not inherited.

The runtime validates the replacement before IDs, context preparation, or
cancellation. It checks the replacement again after asynchronous preparation.

### Admission boundaries

Admission never enters `HarnessRunRequest`, a wire schema, a native binding, an
adapter, or an event. Apart from the opaque session-binding fingerprint, it
does not enter persistence.

The runtime never derives admission from an engine name. It never lets an
untrusted request select its own constraints. Credential lookup and fingerprint
composition stay host responsibilities.

Use the package admission resolver for catalog lookup, settings resolution, and
input validation. You may also provide an equivalent admitted snapshot.

## Request snapshots

The runtime snapshots the admitted request synchronously. The snapshot includes
session identity, input bytes, inline context, settings, configuration, and
metadata.

A host may mutate a caller-owned object after `start` or `followUp`. That
change cannot reach the event identity. It cannot reach the engine request that
already crossed admission.

## Checkpoints

Each resumable adapter declares one current checkpoint format. It may also
declare older compatible formats.

The runtime stores that open identifier with a schema-versioned opaque token.
It never offers unknown, malformed, or incompatible state to an engine.

Call `resetSession` to close and forget an inactive session before you start
fresh on purpose.

An adapter also receives a runtime-owned checkpoint writer. An engine-created
session is therefore durable before a long turn completes or fails. The runtime
refuses a late writer from a reset or closed adapter generation.

## Cancellation

Cancellation changes the terminal status to `interrupted`. It then asks the
adapter to settle.

Events that the adapter yields while it settles are still durable. Partial text
and terminal tool states describe work that already happened. They must precede
the runtime-owned `turn-completed` event.

Cancellation has three ordered boundaries:

1. Dispatch the cancel to the adapter.
2. Drain the engine turn.
3. Persist and close the runtime terminal envelope.

The session stays reserved through all three boundaries.

Other cancellation rules:

- An external abort uses the same dispatch path.
- A cancellation failure does not bypass the drain.
- A session that finishes opening after cancellation is closed without running.
- `HarnessAdapterOpenRequest` therefore carries the owning abort signal.

Runtime shutdown retires a pending checkpoint load or engine open without
waiting forever. It closes an already resolved session independently. It also
closes a session that a non-conforming adapter resolves after retirement.

A late persistence rejection stays observed. It cannot revive the retired turn
and it cannot fail it.

An adapter must stop opening on abort. It must release a partially allocated
engine resource before it settles.

## Diagnostics

The diagnostic observer is optional. It receives process-local, sanitized
lifecycle failures.

Each diagnostic carries these fields:

- a versioned envelope;
- adapter, session, and run identity where available;
- a phase;
- the same safe error code and message boundary used elsewhere.

The observer never receives a raw exception, a prompt, a credential, a tool
result, or a checkpoint token. It is not an event store. A callback failure
cannot change runtime behavior.

## The turn queue

The turn queue is optional. It is a framework-neutral host primitive. It is not
an engine queue, and it is not part of `HarnessRuntime.start`.

The queue orders opaque host snapshots by the existing tenant, actor, thread,
and adapter identity.

Use it as follows:

1. Choose the safe dispatch boundary in your host.
2. Supply a unique boundary token.
3. The queue leases at most one entry at that boundary.
4. Pass the lease abort signal through asynchronous preparation.
5. Check the lease by completing it.
6. Begin irreversible dispatch in the same synchronous task.

A held entry blocks the tail. Later user intent therefore cannot overtake it.

An unsettled lease carries an abort signal. Holding or draining the queue bumps
a monotonic generation, aborts the lease, and makes late completion invalid.
This rule prevents a known failure: a Stop action drains the visible follow-ups
while a previously taken item is still uploading.

The queue is in-memory. It neither inspects nor persists its generic payload.
You decide whether an intent is a transient follow-up, a durable draft, or a
domain record.

Native same-turn steering, replacement turns, and compaction are separate
lifecycle features. Queueing a message never implies that an adapter can
steer.

## Steering

`HarnessCapabilities.steering` declares `same-turn`, `replacement-turn`, or
both. It never declares waiting.

`HarnessRun.followUp` requires the expected active turn id from the caller.

### Same-turn steering

Same-turn steering reuses the original run, turn, signal, context, and tool
host. It sends only the new untrusted input. It emits no second runtime start
and no intermediate completion.

### Replacement steering

Replacement steering follows this order:

1. Validate the fresh input.
2. Prepare the fresh turn context.
3. Recheck active-turn admission.
4. Cancel the old engine turn, drain it, and seal its terminal event.
5. Call `start` with new run and turn ids.

A replacement must not reuse the old run id, the old turn id, or the old abort
controller. A failed preparation leaves the original turn alive.

Follow-up and Stop operations are serialized per run. An unknown engine failure
becomes a safe runtime error.

## Subagent control

Active subagent control follows the same boundary. `HarnessRun.stopSubagent`
does the following:

1. Accept a non-empty opaque adapter task id.
2. Validate the active run from inside the serialized control lane.
3. Enforce the declared `"stop"` control.
4. Call an optional adapter-session method.

It does not expose the engine session. It does not track or assign task
identity. Obtain an id from the event projection that you chose to support.

An adapter returns whether it accepted the targeted stop. An unsupported
control, an ended turn, and an unsafe failure all become stable sanitized
runtime errors. The parent turn stays active.

The adapter receives a turn-scoped abort signal. Turn completion, cancellation,
and runtime close retire the control lane. A hung engine promise therefore
cannot hold `run.cancel()` or shutdown. A late engine settlement is ignored.
An adapter must use the signal to prevent a late side effect.
