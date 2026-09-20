import {
  createHarness,
  createMemoryPersistence,
  createToolHost,
} from "reins";
import { createScriptedAdapter } from "reins/testing";

const tools = createToolHost([{
  name: "lookup_order",
  description: "Read one order",
  inputSchema: { type: "object", required: ["id"] },
  validate(input) {
    const id = (input as { id?: unknown }).id;
    if (typeof id !== "string") throw new Error("id is required");
    return { id };
  },
  execute: async ({ id }) => ({
    content: [{ type: "text" as const, text: `Order ${id} is ready` }],
  }),
}]);

const fixture = createScriptedAdapter({
  async *script({ tools: turnTools }) {
    const result = await turnTools.call("lookup_order", { id: "42" });
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
  session: { tenantId: "acme", actorId: "ada", threadId: "order-42" },
  adapterId: "scripted",
  input: [{ type: "text", text: "Where is order 42?" }],
});

for await (const event of run.events) console.log(event.payload);
