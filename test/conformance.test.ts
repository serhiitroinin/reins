import { describe, expect, test } from "bun:test";
import { createConformanceFixture, runAdapterConformance } from "../src/testing/index.ts";

describe("adapter conformance", () => {
  test("the reference fixture passes the black-box contract", async () => {
    const report = await runAdapterConformance({ fixture: createConformanceFixture() });

    expect(report.passed).toBe(true);
    expect(report.cases.filter((entry) => entry.status === "failed")).toEqual([]);
    expect(report.cases.map((entry) => entry.name)).toEqual([
      "identity and capabilities",
      "host input policy",
      "host execution admission",
      "event lifecycle",
      "unsafe error redaction",
      "safe error preservation",
      "tool host bridge",
      "context boundary",
      "independent discovery",
      "cancellation and busy session",
      "active-turn follow-up",
      "interaction round trip",
      "resume checkpoint",
    ]);
  });

  test("a broken adapter receives a named conformance failure", async () => {
    const report = await runAdapterConformance({
      fixture: createConformanceFixture({ basicText: "wrong" }),
    });

    expect(report.passed).toBe(false);
    expect(report.cases).toContainEqual({
      name: "event lifecycle",
      status: "failed",
      message: "basic adapter events changed",
    });
  });

  test("a timed out case cancels its run and closes its session", async () => {
    let cancellations = 0;
    let closes = 0;
    const report = await runAdapterConformance({
      fixture: createConformanceFixture({
        hangScenario: "context",
        onCancel: () => { cancellations += 1; },
        onClose: () => { closes += 1; },
      }),
      timeoutMs: 20,
    });

    expect(report.cases.find((entry) => entry.name === "context boundary")).toEqual({
      name: "context boundary",
      status: "failed",
      message: "context boundary did not settle within 20 ms",
    });
    expect(cancellations).toBeGreaterThan(0);
    expect(closes).toBeGreaterThan(0);
  });
});
