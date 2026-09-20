# Minimal example

This example runs one streamed turn that calls one tool. It needs no engine
account and no network access.

```bash
bun run example
```

## What it shows

`index.ts` is about 45 lines. It covers the four pieces that every Reins host
needs:

| Piece | In the file |
| --- | --- |
| A tool host | `createToolHost` with one validated `lookup_order` tool |
| An adapter | `createScriptedAdapter`, which calls the tool and yields text |
| The runtime | `createHarness` with in-memory persistence |
| One run | `harness.start(...)`, then a loop over `run.events` |

## What to change next

1. Replace `createMemoryPersistence` with your durable store.
2. Replace the scripted adapter with the Claude Code or Codex adapter.
3. Move credentials and domain state into your host.

`reins/testing` is test-only API. Do not ship the scripted adapter as a
selectable engine in a release build.

## Related pages

- [Node quickstart](../../docs/getting-started/node.md) explains the same code
  step by step.
- [Build your own app on Reins](../../docs/guides/build-an-app.md) takes it to
  a product.
- [Incident terminal](../incident-terminal/README.md) is the complete reference
  host.
