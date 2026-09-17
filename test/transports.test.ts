import { describe, expect, test } from "bun:test";
import { createLineReader, createNdjsonReader } from "../src/transports/ndjson.ts";
import { createJsonRpcPeer, JsonRpcError } from "../src/transports/json-rpc.ts";

describe("NDJSON transport", () => {
  test("reassembles split records and flushes a final line", () => {
    const values: Record<string, unknown>[] = [];
    const reader = createNdjsonReader((value) => values.push(value));
    reader.text('{"text":"hel');
    reader.text('lo"}\n{"last":true}');
    reader.end();
    expect(values).toEqual([{ text: "hello" }, { last: true }]);
  });

  test("drops an overflowing partial line and reports it", () => {
    const overflows: number[] = [];
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line), {
      maxBufferedChars: 4,
      onOverflow: (size) => overflows.push(size),
    });
    reader.text("abcde");
    reader.text("ok\n");
    expect(overflows).toEqual([5]);
    expect(lines).toEqual(["ok"]);
  });

  test("drops an oversized line even when its newline arrives with it", () => {
    const overflows: number[] = [];
    const lines: string[] = [];
    const reader = createLineReader((line) => lines.push(line), {
      maxBufferedChars: 4,
      onOverflow: (size) => overflows.push(size),
    });
    reader.text("abcde\nok\n");
    expect(overflows).toEqual([5]);
    expect(lines).toEqual(["ok"]);
  });
});

describe("JSON-RPC transport", () => {
  test("pairs responses with requests and emits notifications", async () => {
    const written: string[] = [];
    const notifications: string[] = [];
    const peer = createJsonRpcPeer({
      write: (line) => written.push(line),
      hooks: { notification: (method) => notifications.push(method) },
    });
    const result = peer.request<{ id: string }>("thread/start", { cwd: "/work" });
    const id = (JSON.parse(written[0]!) as { id: number }).id;
    peer.text(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: {} })}\n`);
    peer.text(`${JSON.stringify({ jsonrpc: "2.0", id, result: { id: "thread-1" } })}\n`);
    expect(await result).toEqual({ id: "thread-1" });
    expect(notifications).toEqual(["turn/started"]);
  });

  test("answers inbound requests and surfaces outbound errors", async () => {
    const written: string[] = [];
    const peer = createJsonRpcPeer({
      write: (line) => written.push(line),
      hooks: { request: async () => ({ result: { decision: "deny" } }) },
    });
    peer.text(`${JSON.stringify({ jsonrpc: "2.0", id: "ask-1", method: "requestApproval", params: {} })}\n`);
    await Bun.sleep(0);
    expect(JSON.parse(written[0]!)).toEqual({ jsonrpc: "2.0", id: "ask-1", result: { decision: "deny" } });

    const result = peer.request("turn/start", {});
    const id = (JSON.parse(written[1]!) as { id: number }).id;
    peer.text(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "failed" } })}\n`);
    await expect(result).rejects.toThrow(JsonRpcError);
    await expect(result).rejects.toThrow("turn/start: failed");
  });

  test("ending fails every pending request", async () => {
    const peer = createJsonRpcPeer({ write() {} });
    const result = peer.request("turn/start");
    peer.end("child ended");
    await expect(result).rejects.toThrow("child ended");
  });

  test("retires a peer when a late inbound answer loses its output", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let outputClosed = false;
    const peer = createJsonRpcPeer({
      write() {
        if (outputClosed) throw new Error("private transport failure");
      },
      hooks: {
        async request() {
          await held;
          return { result: { ok: true } };
        },
      },
    });
    peer.text(`${JSON.stringify({ jsonrpc: "2.0", id: "tool-1", method: "tool/call" })}\n`);
    const pending = peer.request("turn/status");
    const rejected = pending.catch((error: unknown) => error);

    outputClosed = true;
    release();

    expect(await rejected).toEqual(new Error("the JSON-RPC output closed"));
    await expect(peer.request("turn/start")).rejects.toThrow("the JSON-RPC output closed");
  });
});
