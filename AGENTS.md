# Fold Harness contributor guide

Fold Harness is a provider-neutral TypeScript runtime for building products on
top of agent harnesses. Fold is its first dogfood consumer, not part of the
public library contract.

## Commands

```bash
bun install
bun run check
bun run example
npm pack --dry-run
```

## Boundaries

- Keep provider identifiers open and negotiate optional behavior through
  capabilities.
- Do not expose provider SDK types from the protocol or runtime.
- Keep UI frameworks, product domains, database drivers, credentials, and
  provider account discovery out of the core package.
- The runtime is not a sandbox. Adapters and host documentation must describe
  filesystem, network, shell, authentication, and approval behavior exactly.
- Never inherit a host application's complete environment in an adapter.
- Never put credentials, prompts, tool results, or raw provider errors in
  diagnostics unless an explicit redaction contract covers them.
- Core events evolve additively. Unknown namespaced extensions must remain
  retainable or safely ignorable.
- The runtime owns terminal events and seals a run after completion.
- Provider execution approval and application transaction confirmation are
  different interactions; do not collapse them into one policy decision.

## Changes

Use atomic Conventional Commits. Add tests for public behavior, update the
architecture when a boundary moves, and add a Changeset after the first npm
baseline exists. A provider adapter must pass the conformance suite before it
is documented as supported.

