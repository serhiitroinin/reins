import { describe, expect, test } from "bun:test";
import { createConformanceFixture, runAdapterConformance } from "../src/testing/index.ts";

describe("adapter conformance", () => {
  test("the reference fixture passes the black-box contract", async () => {
    const report = await runAdapterConformance({ fixture: createConformanceFixture() });

    expect(report.passed).toBe(true);
    expect(report.cases.filter((entry) => entry.status === "failed")).toEqual([]);
    expect(report.cases.map((entry) => entry.name)).toEqual([
      "identity and capabilities",
      "event lifecycle",
      "unsafe error redaction",
      "safe error preservation",
      "tool host bridge",
      "context boundary",
      "independent discovery",
      "cancellation and busy session",
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
});
