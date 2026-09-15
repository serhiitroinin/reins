import { describe, expect, test } from "bun:test";
import { bindToolHost, createToolHost } from "../src/tools.ts";

const context = {
  session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
  adapterId: "adapter",
  runId: "run",
  turnId: "turn",
  signal: new AbortController().signal,
  context: { sources: [], unavailable: [] },
};

describe("tool host", () => {
  test("binds trusted turn context outside the provider call", async () => {
    let received = "";
    const host = createToolHost([{
      name: "where",
      description: "Read the trusted turn",
      inputSchema: { type: "object" },
      execute: (_input, toolContext) => {
        received = `${toolContext.session.actorId}:${toolContext.turnId}`;
        return { content: [] };
      },
    }]);
    const tools = bindToolHost(host, context);

    expect(tools.list()).toMatchObject([{ name: "where" }]);
    await tools.call("where", { context: { turnId: "attacker" } });
    expect(received).toBe("actor:turn");
  });

  test("validates and executes an application tool", async () => {
    const tools = createToolHost([{
      name: "greet",
      description: "Greet somebody",
      inputSchema: { type: "object", required: ["name"] },
      validate(input) {
        const name = (input as { name?: unknown }).name;
        if (typeof name !== "string") throw new Error("name required");
        return { name };
      },
      execute: ({ name }) => ({ content: [{ type: "text", text: `Hello ${name}` }] }),
    }]);
    expect(tools.list(context)).toMatchObject([{ name: "greet" }]);
    expect(await tools.call("greet", { name: "Ada" }, context)).toEqual({
      content: [{ type: "text", text: "Hello Ada" }],
    });
    expect(await tools.call("greet", {}, context)).toMatchObject({ isError: true, code: "TOOL_INPUT_INVALID" });
  });

  test("runs policy before application code", async () => {
    let called = false;
    const tools = createToolHost([{
      name: "write",
      description: "Write a value",
      inputSchema: { type: "object" },
      execute: () => { called = true; return { content: [] }; },
    }], {
      policy: () => ({ decision: "deny", reason: "Needs review" }),
    });
    expect(await tools.call("write", {}, context)).toMatchObject({
      isError: true,
      code: "TOOL_DENIED",
      content: [{ text: "Needs review" }],
    });
    expect(called).toBe(false);
  });
});
