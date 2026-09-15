import { describe, expect, test } from "bun:test";
import {
  HarnessInteractionProjector,
  pendingHarnessInteractions,
  projectHarnessInteractions,
} from "../src/interactions.ts";
import type { HarnessEvent, HarnessEventPayload } from "../src/protocol.ts";

function event(
  sequence: number,
  payload: HarnessEventPayload,
  overrides: Partial<Pick<HarnessEvent, "eventId" | "runId" | "turnId" | "adapterId">> = {},
): HarnessEvent {
  return {
    schemaVersion: 1,
    eventId: overrides.eventId ?? `event-${sequence}`,
    sequence,
    timestamp: `2026-09-15T09:00:${String(sequence).padStart(2, "0")}.000Z`,
    session: { tenantId: "tenant", actorId: "actor", threadId: "thread" },
    runId: overrides.runId ?? "run-1",
    turnId: overrides.turnId ?? "turn-1",
    adapterId: overrides.adapterId ?? "claude",
    payload,
  };
}

const question = (id: string): HarnessEventPayload => ({
  kind: "interaction-requested",
  interaction: { id, kind: "question", title: `Question ${id}` },
});

describe("harness interaction projection", () => {
  test("keeps one provider-neutral FIFO across interaction kinds", () => {
    const projected = pendingHarnessInteractions([
      event(3, {
        kind: "interaction-requested",
        interaction: { id: "confirm", kind: "confirmation", title: "Confirm" },
      }),
      event(1, {
        kind: "interaction-requested",
        interaction: { id: "permission", kind: "permission", title: "Permission" },
      }),
      event(2, question("question")),
    ]);

    expect(projected.map((row) => row.interaction.id)).toEqual([
      "permission",
      "question",
      "confirm",
    ]);
  });

  test("retains resolved and invalidated lifecycle outcomes", () => {
    const projected = projectHarnessInteractions([
      event(1, question("answered")),
      event(2, {
        kind: "interaction-resolved",
        interactionId: "answered",
        response: { text: "yes" },
      }),
      event(3, question("expired")),
      event(4, {
        kind: "interaction-invalidated",
        interactionId: "expired",
        reason: "expired",
        message: "The request expired.",
      }),
    ]);

    expect(projected).toMatchObject([
      { status: "resolved", resolution: { response: { text: "yes" } } },
      {
        status: "invalidated",
        invalidation: { reason: "expired", message: "The request expired." },
      },
    ]);
  });

  test("terminal finality survives overlapping and out-of-order replay pages", () => {
    const projector = new HarnessInteractionProjector();
    const requested = event(2, question("stale"));
    const terminal = event(5, { kind: "turn-completed", status: "interrupted" });

    projector.push(terminal);
    projector.push(requested);
    projector.push(requested);

    expect(projector.pending()).toEqual([]);
    expect(projector.snapshot()).toMatchObject([
      { status: "invalidated", invalidation: { reason: "turn-ended", sequence: 5 } },
    ]);
  });

  test("scopes repeated interaction ids to their exact run and turn", () => {
    const projected = projectHarnessInteractions([
      event(1, question("same"), { runId: "run-1", turnId: "turn-1" }),
      event(2, question("same"), { runId: "run-2", turnId: "turn-2" }),
      event(3, {
        kind: "interaction-resolved",
        interactionId: "same",
        response: { choiceId: "allow" },
      }, { runId: "run-1", turnId: "turn-1" }),
    ]);

    expect(projected.map(({ runId, status }) => [runId, status])).toEqual([
      ["run-1", "resolved"],
      ["run-2", "open"],
    ]);
  });
});
