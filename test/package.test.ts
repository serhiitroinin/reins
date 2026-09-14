import { describe, expect, test } from "bun:test";

describe("package scaffold", () => {
  test("runs tests in an ESM package", async () => {
    expect(await import("../src/index.ts")).toBeDefined();
  });
});

