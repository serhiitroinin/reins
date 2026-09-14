# Fold Harness

Fold Harness is a provider-neutral TypeScript runtime for building
domain-specific products on top of agent harnesses such as Claude Code, Codex,
OpenCode, and ACP-compatible agents.

The project is being extracted from [Fold](https://github.com/serhiitroinin/fold).
Its first releases focus on five boundaries:

- an extensible event protocol for any UI;
- explicit provider capability negotiation;
- durable session and run lifecycle;
- application-owned tools, policy, and human interactions;
- adapter conformance across native and ACP-backed agents.

This repository is currently private while the extraction API is changing.
No npm release has been made yet.

## Development

```bash
bun install
bun run check
```

Node.js 20 or newer is the supported runtime baseline. Bun is used for local
development and tests.

## Design constraints

- Provider identifiers are open strings, never a closed enum.
- Capability claims are negotiated instead of inferred from provider names.
- Provider SDK values do not appear in public runtime types.
- Domain tools and persistence are supplied by the host application.
- Unknown extension events remain forward-compatible.
- An adapter reports its actual security posture; the runtime does not claim
  that a subprocess is sandboxed merely because it was launched by the runtime.

## Status

The package is pre-release software. Fold is the first dogfood consumer.

