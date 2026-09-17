# Node quickstart

This guide creates one streamed turn. The turn calls an application tool.
It runs without a provider account.

## 1. Create a project

Use Node.js 20 or newer.

```sh
mkdir harness-demo
cd harness-demo
npm init -y
npm install @serhiitroinin/fold-harness
```

Add `"type": "module"` to `package.json`.

## 2. Create `index.mjs`

```js
import {
  createHarness,
  createMemoryPersistence,
  createToolHost,
} from "@serhiitroinin/fold-harness";
import { createScriptedAdapter } from "@serhiitroinin/fold-harness/testing";

const tools = createToolHost([{
  name: "get_order",
  description: "Read one order",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  validate(input) {
    if (!input || typeof input !== "object" || typeof input.id !== "string") {
      throw new Error("id is required");
    }
    return { id: input.id };
  },
  async execute({ id }) {
    return { content: [{ type: "text", text: `Order ${id} is ready` }] };
  },
}]);

const fixture = createScriptedAdapter({
  async *script({ tools }) {
    const result = await tools.call("get_order", { id: "42" });
    const first = result.content[0];
    yield {
      kind: "assistant-text",
      text: first?.type === "text" ? first.text : "No result",
    };
  },
});

const harness = createHarness({
  adapters: [fixture.adapter],
  persistence: createMemoryPersistence(),
  tools,
});

const run = harness.start({
  session: { tenantId: "demo", actorId: "user", threadId: "order-42" },
  adapterId: fixture.adapter.id,
  input: [{ type: "text", text: "Where is order 42?" }],
});

for await (const event of run.events) {
  console.log(event.payload);
}

await harness.close();
```

`testing` is for tests and examples. Do not use its scripted adapter in a real
product.

## 3. Run it

```sh
node index.mjs
```

You will see a start event, tool events, assistant text, and one terminal
event.

## 4. Add your product boundary

Replace the memory store with your durable store. Replace the scripted adapter
with the Claude Code or Codex adapter. Keep credentials and domain state in
your host.

See [Claude Code and Codex](native-providers.md) next.
