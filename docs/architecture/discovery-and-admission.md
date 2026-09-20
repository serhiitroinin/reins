# Discovery and admission

This page is part of [the architecture reference](../ARCHITECTURE.md). It uses
the terms in [the glossary](../GLOSSARY.md).

## Three independent calls

The runtime exposes three discovery calls. Each one is independent.

| Call | Returns |
| --- | --- |
| Engine profile | Permission modes, generic controls, security posture, input policy |
| Model catalog | Models, effort options, model-level controls |
| Account limits | Quota, credit, spend, and context snapshots |

Their availability can differ. Their refresh cadence usually differs too. A
model picker can therefore render before limits arrive.

A discovery failure returns an explicit safe message. A raw engine error never
reaches the host.

## Freshness and account scope

An available result can carry a fetch timestamp and an expiry timestamp. The
shared freshness helper classifies those timestamps. It does not expose the
cache implementation.

An unavailable result can carry a safe adapter error code for diagnostics.

An observed native limit snapshot is timestamped and account-scoped. One login
therefore can never inherit the quota display of another login. A request that
names no account reads the account that reported last.

## Live discovery sources

Both native adapters ship a live discovery source.

| Source | Reads |
| --- | --- |
| `createClaudeAgentSdkDiscovery` | The Agent SDK control channel |
| `createCodexAppServerDiscovery` | `model/list` and `account/rateLimits/read` |

Each probe starts one short process. The probe has no turn, no tools, and only
the exact environment that you pass.

Results are cached with `fetchedAt`. An engine can also stream a limit during a
turn. The adapter merges that value over the probe result by limit id when it
is newer.

## Permission vocabulary

An engine profile owns its own permission vocabulary. The core does not pretend
that a Claude approval policy and a Codex sandbox mode mean the same thing.

A permission mode can require a versioned consent. A stored grant resolves to
the safe default when its version no longer matches. An adapter can therefore
change the meaning of an elevated mode without reusing old consent.

## Controls, effort, and model metadata

- A common setting is an adapter-declared control. Its type is toggle, select,
  or number.
- A control identifier is an open string. Its scope is turn, session, or
  account.
- A model can override an engine control when the available values differ.
- Effort stays a first-class model attribute, because its options and its
  default are model-specific.
- An effort option id is still an open string.
- A shared resolver accepts only an advertised value and an advertised
  default.
- Model lifecycle metadata is additive. Availability and legacy status do not
  turn engine identifiers into a closed core enum.

## Limits

A limit is a snapshot. It is separate from the per-turn token and cost usage
events.

One snapshot can represent any of these kinds:

- a rolling rate window;
- credits;
- spend;
- context;
- an unknown future kind.

The snapshot embeds no engine response type.

## Input policy

Engine discovery and model discovery can each declare an input policy. The
engine supplies the defaults. A selected model overrides only the fields that
it knows.

Support and limits are separate. An absent modality, maximum, or media-type
list means unknown. It never means an inferred refusal.

Modality identifiers are open. An ACP adapter or a future native adapter can
add a shape without an engine-name branch in a host.

## The admission resolver

`discoverHarnessAdmission()` is the executable bridge from discovery to the
runtime. It performs these steps:

1. Read the engine profile and the account-scoped model catalog concurrently.
2. Resolve only advertised model and effort defaults.
3. Validate permission consent and every generic control.
4. Merge the input policy.
5. Validate the actual typed input.

Success returns two values: the normalized `HarnessRunRequest`, and the exact
`HarnessAdmission` that pins it.

Failure returns safe typed issues and no admission. A stale picker therefore
cannot reach an adapter.

`resolveHarnessAdmission()` is the pure variant. It accepts a snapshot that you
already fetched. Use it when your UI owns discovery caching.

## What admission does not decide

The resolver treats an account id and a session binding as opaque host-owned
identities. It validates only that a supplied value is not empty.

These items stay outside the package:

- credential lookup;
- authorization;
- the contents of the non-secret binding fingerprint.

Limit snapshots are deliberately not folded into admission. A usage display and
a hard execution authorization are different contracts.

## Inline context

`HarnessRunRequest.input` is the canonical ordered composer value. It can
interleave text, images, resources, and `context-reference` parts. You do not
need to parse Markdown or depend on a web editor.

The optional versioned `inlineContext` table resolves each reference. Each
record has an open kind, a stable id, a label, and a bounded JSON payload. The
payload is untrusted content.

An unknown kind survives validation. These inputs fail closed with explicit
issues:

- a malformed envelope;
- a duplicate id;
- a stale reference;
- a cycle;
- an exceeded bound.

### Attachments stay at the input boundary

An attachment or resource binding points to the id of an ordinary image or
resource input. Bytes and engine resource URIs stay at that input boundary.
They do not enter the context record.

You can therefore persist draft references and attachment metadata without
persisting binary payloads in the record table.

The package supplies pure resolution and policy-validation functions. The host
owns uploads, record lookup, authorization, freshness, storage, and rendering.

### Inline context is not a context source

Inline context is user input. A prepared context source is host-owned domain
state. See [tools and context](tools-and-context.md).

An adapter's default input mapper renders a validated inline reference as
untrusted content. Replace that mapping when an engine supports a richer
native form.
