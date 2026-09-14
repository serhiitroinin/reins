import { describe, expect, test } from "bun:test";
import {
  HarnessContextPreparationError,
  HarnessContextSourceError,
  prepareHarnessContext,
  prepareHarnessContextSync,
  type HarnessContextSource,
} from "../src/context.ts";

describe("context sources", () => {
  test("prepares sources concurrently and returns them in registration order", async () => {
    let releaseFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let secondRan = false;
    const sources: HarnessContextSource<string, string>[] = [
      {
        id: "app:first",
        failureMode: "required",
        async prepare(request) {
          await firstReady;
          return `${request}:first`;
        },
      },
      {
        id: "app:second",
        failureMode: "required",
        prepare(request) {
          secondRan = true;
          releaseFirst();
          return `${request}:second`;
        },
      },
    ];

    const prepared = await prepareHarnessContext(sources, "turn");
    expect(secondRan).toBe(true);
    expect(prepared.sources).toEqual([
      { sourceId: "app:first", value: "turn:first" },
      { sourceId: "app:second", value: "turn:second" },
    ]);
    expect(prepared.unavailable).toEqual([]);
  });

  test("isolates a classified optional failure without exposing its raw message", async () => {
    const raw = new Error("/secret/customer/path");
    const observed: unknown[] = [];
    const prepared = await prepareHarnessContext([{
      id: "app:vault",
      failureMode: "optional",
      prepare: () => { throw raw; },
      isUnavailableError: (error) => error === raw,
    }], undefined, {
      onError: (error) => observed.push(error),
    });

    expect(prepared.sources).toEqual([]);
    expect(prepared.unavailable).toEqual([{
      sourceId: "app:vault",
      code: "CONTEXT_SOURCE_UNAVAILABLE",
      message: "Context source \"app:vault\" is unavailable.",
    }]);
    expect(observed).toEqual([raw]);
  });

  test("keeps explicitly safe failure details", async () => {
    const prepared = await prepareHarnessContext([{
      id: "app:search",
      failureMode: "optional",
      prepare: () => { throw new HarnessContextSourceError("SEARCH_OFFLINE", "Search is offline.", true); },
    }], undefined);

    expect(prepared.unavailable).toEqual([{
      sourceId: "app:search",
      code: "SEARCH_OFFLINE",
      message: "Search is offline.",
      retryable: true,
    }]);
  });

  test("fails a turn when a required source returns no context", async () => {
    await expect(prepareHarnessContext([{
      id: "app:policy",
      failureMode: "required",
      prepare: () => null,
    }], undefined)).rejects.toMatchObject({
      name: "HarnessContextPreparationError",
      sourceId: "app:policy",
      code: "CONTEXT_SOURCE_UNAVAILABLE",
    });
  });

  test("does not hide an error the application did not classify", async () => {
    const bug = new Error("bug");
    await expect(prepareHarnessContext([{
      id: "app:optional",
      failureMode: "optional",
      prepare: () => { throw bug; },
    }], undefined)).rejects.toBe(bug);
  });

  test("supports synchronous hosts and refuses asynchronous sources", () => {
    const prepared = prepareHarnessContextSync([{
      id: "app:local",
      failureMode: "required",
      prepare: (request: number) => request + 1,
    }], 41);
    expect(prepared.sources[0]?.value).toBe(42);

    expect(() => prepareHarnessContextSync([{
      id: "app:async",
      failureMode: "optional",
      prepare: async () => "later",
    }], undefined)).toThrow("returned a Promise during synchronous preparation");
  });

  test("rejects duplicate identifiers before invoking a source", async () => {
    let calls = 0;
    const source = {
      id: "app:same",
      failureMode: "optional" as const,
      prepare: () => { calls += 1; return "value"; },
    };
    await expect(prepareHarnessContext([source, source], undefined)).rejects.toThrow("duplicate context source");
    expect(calls).toBe(0);
  });

  test("required source errors expose only the explicit public contract", async () => {
    const failure = new HarnessContextSourceError("POLICY_MISSING", "Workspace policy is unavailable.");
    try {
      await prepareHarnessContext([{
        id: "app:policy",
        failureMode: "required",
        prepare: () => { throw failure; },
      }], undefined);
      throw new Error("expected preparation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessContextPreparationError);
      expect(error).toMatchObject({
        code: "POLICY_MISSING",
        publicMessage: "Workspace policy is unavailable.",
      });
    }
  });
});
