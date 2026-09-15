import { describe, expect, test } from "bun:test";
import { createHarnessMcpServer } from "../src/mcp.ts";
import { createToolHost, type HarnessToolContext, type HarnessToolHost } from "../src/tools.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const context: HarnessToolContext = {
  session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
  adapterId: "test-adapter",
  runId: "run",
  turnId: "turn",
  signal: new AbortController().signal,
  context: { sources: [], unavailable: [] },
};

interface Fixture {
  readonly written: Uint8Array[];
  readonly server: ReturnType<typeof createHarnessMcpServer>;
  receive(value: unknown): void;
  responses(): unknown[];
}

function fixture(host: HarnessToolHost, options: {
  maxFrameBytes?: number;
  maxConcurrentCalls?: number;
  maxToolsPerPage?: number;
} = {}): Fixture {
  const written: Uint8Array[] = [];
  const server = createHarnessMcpServer({
    host,
    context,
    serverInfo: { name: "test-harness", version: "1.2.3" },
    write: (chunk) => written.push(chunk.slice()),
    ...options,
  });
  return {
    written,
    server,
    receive(value) {
      server.receive(encoder.encode(`${JSON.stringify(value)}\n`));
    },
    responses() {
      return decoder.decode(concat(written)).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function request(id: string | number, method: string, params?: unknown) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

function initialize(target: Fixture): void {
  target.receive(request(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  }));
  target.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
}

const emptyHost: HarnessToolHost = { list: () => [], call: async () => ({ content: [] }) };

describe("Harness MCP server", () => {
  test("requires initialize, announces the server, and answers ping", () => {
    const target = fixture(emptyHost);
    target.receive(request("before", "tools/list"));
    expect(target.responses()).toEqual([{
      jsonrpc: "2.0",
      id: "before",
      error: { code: -32002, message: "Server not initialized" },
    }]);

    initialize(target);
    expect(target.server.initialized).toBe(true);
    expect(target.responses()[1]).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "test-harness", version: "1.2.3" },
      },
    });

    target.receive(request("ping", "ping"));
    expect(target.responses().at(-1)).toEqual({ jsonrpc: "2.0", id: "ping", result: {} });
  });

  test("maps exact tool descriptors and results without exposing host metadata", async () => {
    const seen: unknown[] = [];
    const host = createToolHost([{
      name: "inspect",
      description: "Inspect a record",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      metadata: { internal: "must-not-cross-the-MCP-boundary" },
      validate: (input) => input,
      execute: async (input) => {
        seen.push(input);
        return {
          content: [
            { type: "text", text: "hello" },
            { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
            { type: "resource", uri: "memory://record/1", mediaType: "application/json", text: "{\"ok\":true}" },
          ],
          metadata: { internal: true },
        };
      },
    }]);
    const target = fixture(host);
    initialize(target);

    target.receive(request("list", "tools/list", {}));
    expect(target.responses().at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "list",
      result: {
        tools: [{
          name: "inspect",
          description: "Inspect a record",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        }],
      },
    });

    target.receive(request("call", "tools/call", { name: "inspect", arguments: { id: "1" } }));
    await Bun.sleep(0);
    expect(seen).toEqual([{ id: "1" }]);
    expect(target.responses().at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "call",
      result: {
        content: [
          { type: "text", text: "hello" },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
          { type: "resource", resource: { uri: "memory://record/1", mimeType: "application/json", text: "{\"ok\":true}" } },
        ],
      },
    });
  });

  test("runs one host call so its policy precedes validation and execution", async () => {
    const order: string[] = [];
    let calls = 0;
    const host = createToolHost([{
      name: "write",
      description: "Write",
      inputSchema: { type: "object" },
      validate: () => { order.push("validate"); return {}; },
      execute: () => { calls += 1; order.push("execute"); return { content: [] }; },
    }], { policy: () => { order.push("policy"); return { decision: "allow" }; } });
    const target = fixture(host);
    initialize(target);
    target.receive(request("write", "tools/call", { name: "write", arguments: {} }));
    await Bun.sleep(0);
    expect(order).toEqual(["policy", "validate", "execute"]);
    expect(calls).toBe(1);
    expect(target.responses().at(-1)).toEqual({ jsonrpc: "2.0", id: "write", result: { content: [] } });
  });

  test("returns safe tool failures and standard errors for unknown methods and tools", async () => {
    const host = createToolHost([{
      name: "explode",
      description: "Explodes",
      inputSchema: { type: "object" },
      execute: () => { throw new Error("secret host detail"); },
    }]);
    const target = fixture(host);
    initialize(target);
    target.receive(request("unknown-method", "not/a/method", {}));
    target.receive(request("unknown-tool", "tools/call", { name: "missing", arguments: {} }));
    target.receive(request("explode", "tools/call", { name: "explode", arguments: {} }));
    await Bun.sleep(0);
    const messages = target.responses();
    expect(messages.at(-3)).toEqual({
      jsonrpc: "2.0", id: "unknown-method", error: { code: -32601, message: "Method not found: not/a/method" },
    });
    expect(messages.at(-2)).toEqual({
      jsonrpc: "2.0", id: "unknown-tool", result: {
        content: [{ type: "text", text: "Unknown tool: missing" }], isError: true,
      },
    });
    expect(messages.at(-1)).toEqual({
      jsonrpc: "2.0", id: "explode", result: {
        content: [{ type: "text", text: "Tool failed: explode" }], isError: true,
      },
    });
    expect(JSON.stringify(messages.at(-1))).not.toContain("secret host detail");
  });

  test("closes on malformed JSON or a frame beyond the byte limit", () => {
    const malformed = fixture(emptyHost);
    malformed.server.receive(encoder.encode('{"jsonrpc":"2.0" nope}\n'));
    expect(malformed.server.closed).toBe(true);
    expect(malformed.written).toEqual([]);
    malformed.server.receive(encoder.encode(`${JSON.stringify(request("later", "ping"))}\n`));
    expect(malformed.written).toEqual([]);

    const overflow = fixture(emptyHost, { maxFrameBytes: 12 });
    overflow.server.receive(encoder.encode("1234567890123"));
    expect(overflow.server.closed).toBe(true);
    expect(overflow.written).toEqual([]);
  });

  test("decodes UTF-8 split chunks and emits large catalog and result frames whole", async () => {
    const text = "été 🫡";
    const tools = Array.from({ length: 64 }, (_, index) => ({
      name: `tool_${index}`,
      description: `${text} ${index}`,
      inputSchema: { type: "object" },
      execute: () => ({ content: [{ type: "text" as const, text: `${text} ${"x".repeat(8_000)}` }] }),
    }));
    const target = fixture(createToolHost(tools), { maxFrameBytes: 1_000_000 });
    const init = encoder.encode(`${JSON.stringify(request(1, "initialize", {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: text, version: "1" },
    }))}\n`);
    for (let index = 0; index < init.byteLength; index += 2) target.server.receive(init.slice(index, index + 2));
    target.server.receive(encoder.encode('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
    target.receive(request("list", "tools/list", {}));
    target.receive(request("large", "tools/call", { name: "tool_0", arguments: {} }));
    await Bun.sleep(0);
    const messages = target.responses();
    expect((messages.at(-2) as { result: { tools: unknown[] } }).result.tools).toHaveLength(64);
    expect((messages.at(-1) as { result: { content: Array<{ text: string }> } }).result.content[0]?.text).toContain(text);
  });

  test("paginates a stable catalog and rejects an invalid cursor", () => {
    const host = createToolHost(Array.from({ length: 5 }, (_, index) => ({
      name: `tool_${index}`,
      description: `Tool ${index}`,
      inputSchema: { type: "object" },
      execute: () => ({ content: [] }),
    })));
    const target = fixture(host, { maxToolsPerPage: 2 });
    initialize(target);
    target.receive(request("first", "tools/list", {}));
    const first = target.responses().at(-1) as {
      result: { tools: Array<{ name: string }>; nextCursor?: string };
    };
    expect(first.result.tools.map((tool) => tool.name)).toEqual(["tool_0", "tool_1"]);
    expect(first.result.nextCursor).toBeString();

    target.receive(request("second", "tools/list", { cursor: first.result.nextCursor }));
    const second = target.responses().at(-1) as {
      result: { tools: Array<{ name: string }>; nextCursor?: string };
    };
    expect(second.result.tools.map((tool) => tool.name)).toEqual(["tool_2", "tool_3"]);
    target.receive(request("last", "tools/list", { cursor: second.result.nextCursor }));
    expect(target.responses().at(-1)).toMatchObject({
      id: "last",
      result: { tools: [{ name: "tool_4" }] },
    });

    target.receive(request("invalid", "tools/list", { cursor: "made-up" }));
    expect(target.responses().at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "invalid",
      error: { code: -32602, message: "Invalid tools/list cursor." },
    });
  });

  test("replaces an oversized result with a bounded protocol error", async () => {
    const target = fixture(createToolHost([{
      name: "large",
      description: "Return too much",
      inputSchema: { type: "object" },
      execute: () => ({ content: [{ type: "text", text: "x".repeat(1_000) }] }),
    }]), { maxFrameBytes: 400 });
    initialize(target);
    target.receive(request("large", "tools/call", { name: "large", arguments: {} }));
    await Bun.sleep(0);
    expect(target.responses().at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "large",
      error: { code: -32603, message: "The MCP response exceeded its safe frame limit." },
    });
    expect(target.server.closed).toBe(false);
  });

  test("cancels the active request and never accepts context from the wire", async () => {
    let receivedContext: HarnessToolContext | undefined;
    let receivedSignal: AbortSignal | undefined;
    const host: HarnessToolHost = {
      list: () => [{ name: "wait", description: "Wait", inputSchema: { type: "object" } }],
      call: async (_name, _input, received) => {
        receivedContext = received;
        receivedSignal = received.signal;
        return await new Promise((resolve) => {
          received.signal.addEventListener("abort", () => resolve({
            content: [{ type: "text", text: "cancelled" }], isError: true, code: "TOOL_CANCELLED",
          }), { once: true });
        });
      },
    };
    const target = fixture(host);
    initialize(target);
    target.receive(request("active", "tools/call", {
      name: "wait",
      arguments: {},
      context: { session: { tenantId: "attacker" }, adapterId: "attacker" },
    }));
    await Bun.sleep(0);
    expect(receivedContext?.session).toEqual(context.session);
    expect(receivedContext?.adapterId).toBe(context.adapterId);
    expect(receivedSignal?.aborted).toBe(false);
    const before = target.written.length;
    target.receive({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "active", reason: "user stopped" } });
    await Bun.sleep(0);
    expect(receivedSignal?.aborted).toBe(true);
    // MCP cancellation has no response. A late tool result cannot race the
    // cancelled request back into the client.
    expect(target.written).toHaveLength(before);
  });

  test("refuses tool calls beyond the configured concurrency bound", async () => {
    const signals: AbortSignal[] = [];
    const target = fixture({
      list: () => [{ name: "wait", description: "Wait", inputSchema: { type: "object" } }],
      call: async (_name, _input, received) => {
        signals.push(received.signal);
        return await new Promise((resolve) => received.signal.addEventListener("abort", () => {
          resolve({ content: [] });
        }, { once: true }));
      },
    }, { maxConcurrentCalls: 2 });
    initialize(target);
    target.receive(request("one", "tools/call", { name: "wait", arguments: {} }));
    target.receive(request("two", "tools/call", { name: "wait", arguments: {} }));
    target.receive(request("three", "tools/call", { name: "wait", arguments: {} }));
    await Bun.sleep(0);
    expect(signals).toHaveLength(2);
    expect(target.responses().at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "three",
      error: { code: -32000, message: "Too many tool calls are active." },
    });
    target.server.end();
  });

  test("aborts active tools and drops late results when the server ends", async () => {
    let signal: AbortSignal | undefined;
    const target = fixture({
      list: () => [{ name: "wait", description: "Wait", inputSchema: { type: "object" } }],
      call: async (_name, _input, received) => {
        signal = received.signal;
        return await new Promise((resolve) => received.signal.addEventListener("abort", () => {
          resolve({ content: [{ type: "text", text: "late" }] });
        }, { once: true }));
      },
    });
    initialize(target);
    target.receive(request("active", "tools/call", { name: "wait", arguments: {} }));
    await Bun.sleep(0);
    const before = target.written.length;
    target.server.end();
    await Bun.sleep(0);
    expect(signal?.aborted).toBe(true);
    expect(target.server.closed).toBe(true);
    expect(target.written).toHaveLength(before);
  });
});
