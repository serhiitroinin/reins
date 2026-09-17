import { describe, expect, test } from "bun:test";
import {
  createClaudeAgentSdkConformanceFixture,
  createCodexAppServerConformanceFixture,
  runAdapterReliabilityConformance,
  scriptedCapabilities,
  type AdapterReliabilityFixture,
} from "../src/testing/index.ts";
import type { HarnessAdapter } from "../src/runtime.ts";

describe("native adapter reliability conformance", () => {
  test("Claude survives the shared transport failure matrix", async () => {
    const fixture = createClaudeAgentSdkConformanceFixture();
    const report = await runAdapterReliabilityConformance({ fixture });

    expect(report.passed).toBe(true);
    expect(report.cases.filter((entry) => entry.status === "failed")).toEqual([]);
    expect(report.cases.map((entry) => entry.name)).toEqual([
      "provider death",
      "malformed traffic recovery",
      "cancellation after partial output",
      "incompatible checkpoint rejection",
      "provider checkpoint rejection",
    ]);
  });

  test("Codex survives the shared transport failure matrix", async () => {
    const fixture = createCodexAppServerConformanceFixture();
    const report = await runAdapterReliabilityConformance({ fixture });

    expect(report.passed).toBe(true);
    expect(report.cases.filter((entry) => entry.status === "failed")).toEqual([]);
    expect(report.cases.map((entry) => entry.name)).toEqual([
      "provider death",
      "malformed traffic recovery",
      "cancellation after partial output",
      "incompatible checkpoint rejection",
      "provider checkpoint rejection",
    ]);
  });

  test("a timed-out fixture is closed and drained before the next case", async () => {
    let opens = 0;
    let closes = 0;
    const adapter: HarnessAdapter = {
      id: "hanging-reliability",
      checkpoint: { format: "test:hanging-reliability@1" },
      capabilities: () => scriptedCapabilities,
      async open() {
        opens += 1;
        let release!: () => void;
        const stopped = new Promise<void>((resolve) => { release = resolve; });
        let closed = false;
        return {
          async *run() { await stopped; },
          async cancel() { release(); },
          async close() {
            if (closed) return;
            closed = true;
            closes += 1;
            release();
          },
        };
      },
    };
    const fixture: AdapterReliabilityFixture = {
      adapterId: adapter.id,
      adapter,
      useReliabilityScenario() {},
      providerOpens: () => opens,
      providerCloses: () => closes,
    };

    const report = await runAdapterReliabilityConformance({ fixture, timeoutMs: 10 });

    expect(report.passed).toBe(false);
    expect(report.cases).toHaveLength(5);
    expect(report.cases.every((entry) => entry.status === "failed")).toBe(true);
    expect(closes).toBe(opens);
  });
});
