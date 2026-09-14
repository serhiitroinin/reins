/** In-memory persistence for tests, examples, and single-process prototypes. */

import { harnessSessionKey, type HarnessEvent, type HarnessEventInput, type HarnessSessionKey } from "./protocol.js";
import type { HarnessPersistence, StoredHarnessSession } from "./runtime.js";

export function createMemoryPersistence(options: {
  createId?: () => string;
  now?: () => Date;
} = {}): HarnessPersistence {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const events = new Map<string, HarnessEvent[]>();
  const sessions = new Map<string, StoredHarnessSession>();

  return {
    events: {
      async append(input: HarnessEventInput): Promise<HarnessEvent> {
        const id = harnessSessionKey(input.session, input.adapterId);
        const rows = events.get(id) ?? [];
        const event: HarnessEvent = {
          ...input,
          eventId: createId(),
          sequence: (rows.at(-1)?.sequence ?? 0) + 1,
          timestamp: now().toISOString(),
        };
        rows.push(event);
        events.set(id, rows);
        return event;
      },
      async list(session: HarnessSessionKey, adapterId: string, after = 0): Promise<readonly HarnessEvent[]> {
        return [...(events.get(harnessSessionKey(session, adapterId)) ?? [])]
          .filter((event) => event.sequence > after);
      },
    },
    sessions: {
      async load(session, adapterId) {
        return sessions.get(harnessSessionKey(session, adapterId)) ?? null;
      },
      async save(session) {
        sessions.set(harnessSessionKey(session.key, session.adapterId), structuredClone(session));
      },
      async remove(session, adapterId) {
        sessions.delete(harnessSessionKey(session, adapterId));
      },
    },
  };
}

