import { expect, test } from "bun:test";
import { createHarness, createMemoryPersistence } from "../src/index.ts";
import { createScriptedAdapter } from "../src/testing/index.ts";

test("the scripted adapter drives a complete runtime turn", async () => {
  const fixture = createScriptedAdapter({
    resumeToken: "resume-1",
    async *script(request) {
      const text = request.input[0]?.type === "text" ? request.input[0].text : "";
      yield { kind: "assistant-text", text: `echo: ${text}` };
    },
  });
  const runtime = createHarness({ adapters: [fixture.adapter], persistence: createMemoryPersistence() });
  const run = runtime.start({
    session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
    adapterId: "scripted",
    input: [{ type: "text", text: "hello" }],
  });
  const kinds: string[] = [];
  for await (const event of run.events) kinds.push(event.payload.kind);
  expect(kinds).toEqual(["turn-started", "assistant-text", "turn-completed"]);
  expect(await run.done).toBe("completed");
  expect(fixture.state.runs).toHaveLength(1);
});

