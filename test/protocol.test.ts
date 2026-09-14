import { describe, expect, test } from "bun:test";
import { harnessSessionKey, isHarnessEvent, type HarnessEvent } from "../src/protocol.ts";

describe("harness protocol", () => {
  test("session keys cannot collide across identity fields", () => {
    expect(harnessSessionKey({ tenantId: "a", actorId: "bc", threadId: "d" }, "codex"))
      .not.toBe(harnessSessionKey({ tenantId: "ab", actorId: "c", threadId: "d" }, "codex"));
  });

  test("recognizes a persisted event envelope", () => {
    const event: HarnessEvent = {
      schemaVersion: 1,
      eventId: "event-1",
      sequence: 1,
      timestamp: "2026-09-14T12:00:00.000Z",
      session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
      runId: "run-1",
      turnId: "turn-1",
      adapterId: "example",
      payload: { kind: "assistant-text", text: "hello" },
    };
    expect(isHarnessEvent(event)).toBe(true);
    expect(isHarnessEvent({ ...event, sequence: 0 })).toBe(false);
    expect(isHarnessEvent({ ...event, payload: null })).toBe(false);
  });
});

