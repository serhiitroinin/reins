import { describe, expect, test } from "bun:test";
import {
  createClaudeAgentSdkConformanceFixture,
  createCodexAppServerConformanceFixture,
  runAdapterReliabilityConformance,
} from "../src/testing/index.ts";

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
});
