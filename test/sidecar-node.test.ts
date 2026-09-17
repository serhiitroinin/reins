import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { runHarnessSidecarStdio } from "../src/sidecar-node.ts";
import { createMemoryPersistence } from "../src/stores.ts";
import type { HarnessAdapter } from "../src/runtime.ts";

const unsupported = { support: "unsupported" as const };
const adapter: HarnessAdapter = {
  id: "test",
  capabilities: () => ({
    resume: unsupported,
    cancel: unsupported,
    interactions: unsupported,
    tools: unsupported,
    images: unsupported,
    thinking: unsupported,
    plans: unsupported,
    usage: unsupported,
    subagents: unsupported,
    shell: unsupported,
    filesystem: unsupported,
    network: unsupported,
  }),
  async open() {
    throw new Error("not used");
  },
};

function frame(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error("timed out");
    await Bun.sleep(1);
  }
}

describe("Node sidecar stdio", () => {
  test("negotiates over newline-delimited streams and shuts down cleanly", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk) => { written += chunk.toString("utf8"); });
    const running = runHarnessSidecarStdio({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      input,
      output,
      server: { name: "test-sidecar", version: "1" },
    });

    input.write(frame(1, "harness/initialize", {
      protocolVersion: 1,
      client: { name: "native-test", version: "1" },
    }));
    await waitFor(() => written.includes('"id":1'));
    const initialized = JSON.parse(written.trim().split("\n")[0]!);
    expect(initialized).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        server: { name: "test-sidecar", version: "1" },
        adapters: ["test"],
      },
    });

    input.write(frame(2, "harness/shutdown", {}));
    await running.done;
    const lines = written.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.at(-1)).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(lines).toHaveLength(2);
  });

  test("fails and retires the runtime when stdout backpressure exceeds the bound", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const running = runHarnessSidecarStdio({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      input,
      output,
      maxPendingOutputBytes: 10,
    });
    input.write(frame(1, "harness/initialize", {
      protocolVersion: 1,
      client: { name: "native-test" },
    }));
    await expect(running.done).rejects.toThrow("stdout queue");
  });

  test("honors host cancellation and validates its output bound", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const controller = new AbortController();
    const running = runHarnessSidecarStdio({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      input,
      output,
      signal: controller.signal,
    });
    controller.abort();
    await running.done;
    expect(() => runHarnessSidecarStdio({
      adapters: [adapter],
      persistence: createMemoryPersistence(),
      input: new PassThrough(),
      output: new PassThrough(),
      maxPendingOutputBytes: 0,
    })).toThrow("positive integer");
  });
});
