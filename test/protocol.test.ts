import { describe, expect, test } from "bun:test";
import {
  harnessInteractionRecovery,
  harnessSessionKey,
  harnessSubagentControls,
  isHarnessEvent,
  type HarnessEvent,
  type HarnessRunRequest,
  type HarnessSteeringCapability,
} from "../src/protocol.ts";

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

  test("keeps model effort as an open run option", () => {
    const request: HarnessRunRequest = {
      session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
      adapterId: "codex",
      input: [{ type: "text", text: "hello" }],
      model: "gpt-example",
      effort: "provider:future-effort",
    };

    expect(request.effort).toBe("provider:future-effort");
  });

  test("keeps provider steering distinct from host-side waiting", () => {
    const steering: HarnessSteeringCapability = {
      support: "stable",
      strategies: ["same-turn", "replacement-turn"],
      preferred: "same-turn",
    };

    expect(steering.strategies).not.toContain("wait");
  });

  test("treats old interaction capabilities as live-process only", () => {
    expect(harnessInteractionRecovery({ support: "stable" })).toBe("live-only");
    expect(harnessInteractionRecovery({
      support: "stable",
      recovery: "provider-replay",
    })).toBe("provider-replay");
  });

  test("treats old subagent capabilities as observation-only", () => {
    expect(harnessSubagentControls({ support: "stable" })).toEqual([]);
    expect(harnessSubagentControls({ support: "stable", controls: ["stop"] })).toEqual(["stop"]);
    expect(harnessSubagentControls({ support: "unsupported", controls: ["stop"] })).toEqual([]);
  });
});
