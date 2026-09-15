/**
 * Framework-neutral coordination for follow-ups a host accepts while a
 * provider turn is still running.
 *
 * This queue owns intent ordering only. It does not call the runtime, persist
 * prompts, infer provider steering, or choose when a boundary is safe. The
 * host supplies an opaque immutable payload and an explicit boundary token.
 */

import { harnessSessionKey, type HarnessSessionKey } from "./protocol.js";

export interface HarnessTurnQueueBinding {
  session: HarnessSessionKey;
  adapterId: string;
}

export interface HarnessQueuedTurn<T> extends HarnessTurnQueueBinding {
  id: string;
  payload: T;
  createdAt: string;
  held: boolean;
}

export interface HarnessTurnQueueLease<T> {
  readonly entry: HarnessQueuedTurn<T>;
  readonly boundaryId: string;
  readonly generation: number;
  /** Aborted when the lease is returned, held, or drained before settlement. */
  readonly signal: AbortSignal;
}

export interface HarnessEnqueueOptions {
  /** A held entry remains at the head until the host explicitly releases it. */
  held?: boolean;
}

export interface HarnessReturnOptions {
  /** Failed or stopped dispatches should normally return held. */
  held?: boolean;
}

export interface HarnessTurnQueueOptions {
  /** Maximum queued or leased intents for one session. */
  maxDepth: number;
  createId?: () => string;
  now?: () => Date;
}

export type HarnessTurnQueueErrorCode =
  | "INVALID_MAX_DEPTH"
  | "INVALID_ID"
  | "QUEUE_FULL"
  | "DUPLICATE_ID"
  | "INVALID_BOUNDARY";

export class HarnessTurnQueueError extends Error {
  constructor(readonly code: HarnessTurnQueueErrorCode, message: string) {
    super(message);
    this.name = "HarnessTurnQueueError";
  }
}

export interface HarnessTurnQueue<T> {
  /** Enqueue an opaque host snapshot at the tail. */
  enqueue(binding: HarnessTurnQueueBinding, payload: T, options?: HarnessEnqueueOptions): HarnessQueuedTurn<T>;
  /** Stable immutable array identity until this binding changes. */
  list(binding: HarnessTurnQueueBinding): readonly HarnessQueuedTurn<T>[];
  /** Remove one waiting entry. An already leased entry is not removable here. */
  remove(binding: HarnessTurnQueueBinding, id: string): HarnessQueuedTurn<T> | null;
  /** Hold or release one waiting entry without changing its FIFO position. */
  hold(binding: HarnessTurnQueueBinding, id: string): HarnessQueuedTurn<T> | null;
  release(binding: HarnessTurnQueueBinding, id: string): HarnessQueuedTurn<T> | null;
  /**
   * Lease the head for one explicit host boundary.
   *
   * Only one lease may exist per session and the same boundary token cannot
   * take two entries. A held head blocks every later entry.
   */
  takeNext(binding: HarnessTurnQueueBinding, boundaryId: string): HarnessTurnQueueLease<T> | null;
  /**
   * Commit a lease immediately before irreversible dispatch. The host should
   * complete every fallible preparation first, then call this and start the
   * turn in the same synchronous task so a drain cannot interleave.
   */
  complete(lease: HarnessTurnQueueLease<T>): HarnessQueuedTurn<T> | null;
  /** Put an unsettled lease back at the head, held by default. */
  returnToFront(lease: HarnessTurnQueueLease<T>, options?: HarnessReturnOptions): HarnessQueuedTurn<T> | null;
  /**
   * Invalidate an unsettled lease and hold every intent for explicit action.
   * Returns the resulting queue in FIFO order.
   */
  holdAll(binding: HarnessTurnQueueBinding): readonly HarnessQueuedTurn<T>[];
  /** Invalidate an unsettled lease and remove every intent in FIFO order. */
  drain(binding: HarnessTurnQueueBinding): readonly HarnessQueuedTurn<T>[];
  /** Monotonic per-session invalidation generation. */
  generation(binding: HarnessTurnQueueBinding): number;
  /** Subscribe to mutations. Useful for any UI framework with external stores. */
  subscribe(listener: () => void): () => void;
}

interface ActiveLease<T> {
  public: HarnessTurnQueueLease<T>;
  controller: AbortController;
}

const EMPTY: readonly never[] = Object.freeze([]);

function keyOf(binding: HarnessTurnQueueBinding): string {
  return harnessSessionKey(binding.session, binding.adapterId);
}

function withHeld<T>(entry: HarnessQueuedTurn<T>, held: boolean): HarnessQueuedTurn<T> {
  return entry.held === held ? entry : { ...entry, held };
}

/**
 * Create an in-memory queue suitable for browser, server, desktop, or embedded
 * JavaScript hosts. Native hosts can implement the same small contract without
 * adopting this implementation.
 */
export function createHarnessTurnQueue<T>(options: HarnessTurnQueueOptions): HarnessTurnQueue<T> {
  if (!Number.isSafeInteger(options.maxDepth) || options.maxDepth < 1) {
    throw new HarnessTurnQueueError("INVALID_MAX_DEPTH", "maxDepth must be a positive safe integer.");
  }
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const queues = new Map<string, readonly HarnessQueuedTurn<T>[]>();
  const active = new Map<string, ActiveLease<T>>();
  const generations = new Map<string, number>();
  const lastBoundaries = new Map<string, string>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const read = (key: string): readonly HarnessQueuedTurn<T>[] => queues.get(key) ?? EMPTY;

  const write = (key: string, entries: readonly HarnessQueuedTurn<T>[]): void => {
    if (entries.length === 0) queues.delete(key);
    else queues.set(key, entries);
    notify();
  };

  const currentGeneration = (key: string): number => generations.get(key) ?? 0;

  const invalidate = (key: string): ActiveLease<T> | null => {
    generations.set(key, currentGeneration(key) + 1);
    const lease = active.get(key) ?? null;
    active.delete(key);
    lease?.controller.abort();
    return lease;
  };

  const mutateHeld = (
    binding: HarnessTurnQueueBinding,
    id: string,
    held: boolean,
  ): HarnessQueuedTurn<T> | null => {
    const key = keyOf(binding);
    const entries = read(key);
    const index = entries.findIndex((entry) => entry.id === id);
    if (index < 0) return null;
    const changed = withHeld(entries[index]!, held);
    if (changed !== entries[index]) {
      const next = [...entries];
      next[index] = changed;
      write(key, next);
    }
    return changed;
  };

  return {
    enqueue(binding, payload, enqueueOptions = {}) {
      const key = keyOf(binding);
      const entries = read(key);
      if (entries.length + (active.has(key) ? 1 : 0) >= options.maxDepth) {
        throw new HarnessTurnQueueError(
          "QUEUE_FULL",
          `This harness session already has ${options.maxDepth} queued turn${options.maxDepth === 1 ? "" : "s"}.`,
        );
      }
      const id = createId();
      if (id.length === 0) {
        throw new HarnessTurnQueueError("INVALID_ID", "A queued turn id cannot be empty.");
      }
      if (entries.some((entry) => entry.id === id) || active.get(key)?.public.entry.id === id) {
        throw new HarnessTurnQueueError("DUPLICATE_ID", `Duplicate queued turn id: ${id}`);
      }
      const entry: HarnessQueuedTurn<T> = {
        id,
        session: { ...binding.session },
        adapterId: binding.adapterId,
        payload,
        createdAt: now().toISOString(),
        held: enqueueOptions.held === true,
      };
      write(key, [...entries, entry]);
      return entry;
    },

    list(binding) {
      return read(keyOf(binding));
    },

    remove(binding, id) {
      const key = keyOf(binding);
      const entries = read(key);
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return null;
      const removed = entries[index]!;
      write(key, [...entries.slice(0, index), ...entries.slice(index + 1)]);
      return removed;
    },

    hold(binding, id) {
      return mutateHeld(binding, id, true);
    },

    release(binding, id) {
      return mutateHeld(binding, id, false);
    },

    takeNext(binding, boundaryId) {
      if (boundaryId.length === 0) {
        throw new HarnessTurnQueueError("INVALID_BOUNDARY", "A queue boundary id cannot be empty.");
      }
      const key = keyOf(binding);
      if (active.has(key) || lastBoundaries.get(key) === boundaryId) return null;
      const entries = read(key);
      const entry = entries[0];
      if (!entry || entry.held) return null;
      const controller = new AbortController();
      const lease: HarnessTurnQueueLease<T> = {
        entry,
        boundaryId,
        generation: currentGeneration(key),
        signal: controller.signal,
      };
      active.set(key, { public: lease, controller });
      lastBoundaries.set(key, boundaryId);
      write(key, entries.slice(1));
      return lease;
    },

    complete(lease) {
      const key = keyOf(lease.entry);
      const current = active.get(key);
      if (current?.public !== lease || lease.generation !== currentGeneration(key) || lease.signal.aborted) {
        return null;
      }
      active.delete(key);
      notify();
      return lease.entry;
    },

    returnToFront(lease, returnOptions = {}) {
      const key = keyOf(lease.entry);
      const current = active.get(key);
      if (current?.public !== lease || lease.generation !== currentGeneration(key)) return null;
      active.delete(key);
      current.controller.abort();
      const returned = withHeld(lease.entry, returnOptions.held !== false);
      write(key, [returned, ...read(key).filter((entry) => entry.id !== returned.id)]);
      return returned;
    },

    holdAll(binding) {
      const key = keyOf(binding);
      const leased = invalidate(key)?.public.entry;
      const entries = [...(leased ? [leased] : []), ...read(key)]
        .map((entry) => withHeld(entry, true));
      write(key, entries);
      return entries;
    },

    drain(binding) {
      const key = keyOf(binding);
      const leased = invalidate(key)?.public.entry;
      const drained = [...(leased ? [leased] : []), ...read(key)];
      write(key, EMPTY);
      return drained;
    },

    generation(binding) {
      return currentGeneration(keyOf(binding));
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
