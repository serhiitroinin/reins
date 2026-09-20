# Security policy

## Supported versions

Version 0.1 and later receive security fixes. Earlier versions do not.

## What Reins does not do

Reins coordinates processes and tools. It does not provide operating-system
sandboxing.

A capability reports engine behavior. It grants no authority. Each adapter must
describe its filesystem, network, shell, authentication, and approval behavior
accurately.

## Rules for a host

1. Build an explicit environment map for every engine process. Never forward
   your complete environment.
2. Keep credentials out of process arguments, persisted events, test fixtures,
   and diagnostics.
3. Scope every store by tenant and by actor.
4. Decide explicitly whether a tool or a subprocess may reach the filesystem or
   the network.
5. Do not treat a permission callback as proof that approval happened. Install
   and verify the matching policy rules.

Read [the security boundary](docs/ARCHITECTURE.md#security-boundary) for the
complete contract.

## Report a vulnerability

Report a vulnerability privately through the GitHub security advisory flow for
this repository. Do not open a public issue.

Include the affected version, the reproduction steps, and the impact that you
observed.
