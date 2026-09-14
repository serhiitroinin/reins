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

## Minimal runtime

```ts
import {
  createHarness,
  createMemoryPersistence,
  createToolHost,
} from "@fold-harness/core";
import { createScriptedAdapter } from "@fold-harness/core/testing";

const tools = createToolHost([{
  name: "lookup_order",
  description: "Read one order",
  inputSchema: { type: "object", required: ["id"] },
  execute: async ({ id }: { id: string }) => ({
    content: [{ type: "text", text: `Order ${id} is ready` }],
  }),
}]);

const { adapter } = createScriptedAdapter({
  async *script({ tools }) {
    const result = await tools.call("lookup_order", { id: "42" });
    yield { kind: "assistant-text", text: result.content[0]?.type === "text"
      ? result.content[0].text
      : "No result" };
  },
});

const harness = createHarness({
  adapters: [adapter],
  persistence: createMemoryPersistence(),
  tools,
});

const run = harness.start({
  session: { tenantId: "acme", actorId: "ada", threadId: "order-42" },
  adapterId: "scripted",
  input: [{ type: "text", text: "Where is order 42?" }],
});

for await (const event of run.events) console.log(event.payload);
```

Run the complete example with `bun run example`.

## Package entry points

- `@fold-harness/core` — protocol, runtime, stores, tools, and transports.
- `@fold-harness/core/protocol` — browser-safe public contracts.
- `@fold-harness/core/runtime` — adapter and host lifecycle.
- `@fold-harness/core/adapters/codex-app-server` — Codex JSON-RPC lifecycle.
- `@fold-harness/core/testing` — deterministic host fixtures.

See [the architecture](docs/ARCHITECTURE.md) and [extraction roadmap](docs/ROADMAP.md).

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

The current Fold integration uses the shared NDJSON transport for Claude and
Codex output, the shared pushable input stream for Claude SDK turns, and the
shared App Server lifecycle client for Codex.

