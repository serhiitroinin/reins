/**
 * Framework-neutral projection of the durable interaction lifecycle.
 *
 * Provider callbacks are live process state. This projector says what the
 * event log proves is still actionable; it never claims a callback was
 * restored merely because a provider session has a resume token.
 */

import type {
  HarnessEvent,
  HarnessInteraction,
  HarnessInteractionInvalidationReason,
  HarnessInteractionResponse,
  HarnessSessionKey,
} from "./protocol.js";

export type HarnessProjectedInteractionStatus = "open" | "resolved" | "invalidated";

export interface HarnessInteractionResolution {
  response: HarnessInteractionResponse;
  eventId: string;
  sequence: number;
  timestamp: string;
}

export interface HarnessInteractionInvalidation {
  reason: HarnessInteractionInvalidationReason;
  message?: string;
  eventId: string;
  sequence: number;
  timestamp: string;
}

export interface HarnessProjectedInteraction {
  session: HarnessSessionKey;
  adapterId: string;
  runId: string;
  turnId: string;
  interaction: HarnessInteraction;
  status: HarnessProjectedInteractionStatus;
  requestedEventId: string;
  requestedSequence: number;
  requestedAt: string;
  resolution?: HarnessInteractionResolution;
  invalidation?: HarnessInteractionInvalidation;
}

function scopeKey(event: HarnessEvent, interactionId: string): string {
  return JSON.stringify([
    event.session.tenantId,
    event.session.actorId,
    event.session.threadId,
    event.adapterId,
    event.runId,
    event.turnId,
    interactionId,
  ]);
}

function turnKey(event: HarnessEvent): string {
  return JSON.stringify([
    event.session.tenantId,
    event.session.actorId,
    event.session.threadId,
    event.adapterId,
    event.runId,
    event.turnId,
  ]);
}

function belongsToTurn(
  interaction: HarnessProjectedInteraction,
  event: HarnessEvent,
): boolean {
  return interaction.session.tenantId === event.session.tenantId
    && interaction.session.actorId === event.session.actorId
    && interaction.session.threadId === event.session.threadId
    && interaction.adapterId === event.adapterId
    && interaction.runId === event.runId
    && interaction.turnId === event.turnId;
}

function bySequence(left: HarnessEvent, right: HarnessEvent): number {
  return left.sequence - right.sequence || left.eventId.localeCompare(right.eventId);
}

/**
 * Incremental collector for replay pages and live events.
 *
 * It retains only interaction and terminal events, deduplicated by event id.
 * Snapshot order is recomputed from sequence, so an overlapping or late page
 * cannot resurrect an interaction after its turn became terminal.
 */
export class HarnessInteractionProjector {
  private readonly events = new Map<string, HarnessEvent>();

  push(event: HarnessEvent): void {
    const kind = event.payload.kind;
    if (
      kind !== "interaction-requested"
      && kind !== "interaction-resolved"
      && kind !== "interaction-invalidated"
      && kind !== "turn-completed"
    ) return;
    if (!this.events.has(event.eventId)) this.events.set(event.eventId, event);
  }

  pushAll(events: Iterable<HarnessEvent>): void {
    for (const event of events) this.push(event);
  }

  snapshot(): readonly HarnessProjectedInteraction[] {
    const projected = new Map<string, HarnessProjectedInteraction>();
    const terminalTurns = new Map<string, HarnessEvent>();

    for (const event of [...this.events.values()].sort(bySequence)) {
      const payload = event.payload;
      if (payload.kind === "turn-completed") {
        terminalTurns.set(turnKey(event), event);
        for (const [key, interaction] of projected) {
          if (interaction.status !== "open") continue;
          if (!belongsToTurn(interaction, event)) continue;
          projected.set(key, {
            ...interaction,
            status: "invalidated",
            invalidation: {
              reason: "turn-ended",
              eventId: event.eventId,
              sequence: event.sequence,
              timestamp: event.timestamp,
            },
          });
        }
        continue;
      }

      if (
        payload.kind !== "interaction-requested"
        && payload.kind !== "interaction-resolved"
        && payload.kind !== "interaction-invalidated"
      ) continue;

      const interactionId = payload.kind === "interaction-requested"
        ? payload.interaction.id
        : payload.interactionId;
      const key = scopeKey(event, interactionId);

      if (payload.kind === "interaction-requested") {
        if (projected.has(key)) continue;
        const terminal = terminalTurns.get(turnKey(event));
        projected.set(key, {
          session: { ...event.session },
          adapterId: event.adapterId,
          runId: event.runId,
          turnId: event.turnId,
          interaction: payload.interaction,
          status: terminal ? "invalidated" : "open",
          requestedEventId: event.eventId,
          requestedSequence: event.sequence,
          requestedAt: event.timestamp,
          ...(terminal ? {
            invalidation: {
              reason: "turn-ended" as const,
              eventId: terminal.eventId,
              sequence: terminal.sequence,
              timestamp: terminal.timestamp,
            },
          } : {}),
        });
        continue;
      }

      const existing = projected.get(key);
      if (!existing || existing.status !== "open") continue;
      if (payload.kind === "interaction-resolved") {
        projected.set(key, {
          ...existing,
          status: "resolved",
          resolution: {
            response: payload.response,
            eventId: event.eventId,
            sequence: event.sequence,
            timestamp: event.timestamp,
          },
        });
        continue;
      }
      projected.set(key, {
        ...existing,
        status: "invalidated",
        invalidation: {
          reason: payload.reason,
          ...(payload.message !== undefined ? { message: payload.message } : {}),
          eventId: event.eventId,
          sequence: event.sequence,
          timestamp: event.timestamp,
        },
      });
    }

    return [...projected.values()].sort((left, right) =>
      left.requestedSequence - right.requestedSequence
      || left.requestedEventId.localeCompare(right.requestedEventId));
  }

  pending(): readonly HarnessProjectedInteraction[] {
    return this.snapshot().filter((interaction) => interaction.status === "open");
  }
}

/** Project a complete or accumulated event set in one call. */
export function projectHarnessInteractions(
  events: Iterable<HarnessEvent>,
): readonly HarnessProjectedInteraction[] {
  const projector = new HarnessInteractionProjector();
  projector.pushAll(events);
  return projector.snapshot();
}

/** Return only interactions that remain safe to answer. */
export function pendingHarnessInteractions(
  events: Iterable<HarnessEvent>,
): readonly HarnessProjectedInteraction[] {
  return projectHarnessInteractions(events).filter((interaction) => interaction.status === "open");
}
