/**
 * Session lifecycle shared by every provider adapter.
 *
 * The runtime owns identity, event envelopes, persistence, cancellation, and
 * terminal-event sealing. An adapter owns only provider communication.
 */

import {
  harnessSessionKey,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessEventInput,
  type HarnessEventPayload,
  type HarnessInteractionResponse,
  type HarnessRunRequest,
  type HarnessSessionKey,
  type HarnessTurnStatus,
} from "./protocol.js";
import {
  HarnessContextPreparationError,
  prepareHarnessContext,
  type HarnessContextContribution,
  type HarnessContextPrepareRequest,
  type HarnessContextPreparationOptions,
  type HarnessPreparedContext,
  type HarnessContextSource,
} from "./context.js";
import { emptyToolHost, type HarnessToolHost, type HarnessTurnTools } from "./tools.js";

export type HarnessAdapterEvent = Exclude<
  HarnessEventPayload,
  { kind: "turn-started" } | { kind: "turn-completed" }
>;

export interface HarnessAdapterRunRequest extends HarnessRunRequest {
  runId: string;
  turnId: string;
  signal: AbortSignal;
  tools: HarnessTurnTools;
  context: HarnessPreparedContext<HarnessContextContribution>;
}

export interface HarnessAdapterSession {
  run(request: HarnessAdapterRunRequest): AsyncIterable<HarnessAdapterEvent>;
  respond?(interactionId: string, response: HarnessInteractionResponse): Promise<void>;
  cancel?(): Promise<void>;
  checkpoint?(): Promise<string | null> | string | null;
  close?(): Promise<void>;
}

export interface HarnessAdapterOpenRequest {
  session: HarnessSessionKey;
  resumeToken: string | null;
}

export interface HarnessAdapter {
  readonly id: string;
  capabilities(): Promise<HarnessCapabilities> | HarnessCapabilities;
  open(request: HarnessAdapterOpenRequest): Promise<HarnessAdapterSession>;
}

export interface StoredHarnessSession {
  key: HarnessSessionKey;
  adapterId: string;
  resumeToken: string | null;
  updatedAt: string;
}

export interface HarnessEventStore {
  append(event: HarnessEventInput): Promise<HarnessEvent>;
  list(session: HarnessSessionKey, adapterId: string, after?: number): Promise<readonly HarnessEvent[]>;
}

export interface HarnessSessionStore {
  load(session: HarnessSessionKey, adapterId: string): Promise<StoredHarnessSession | null>;
  save(session: StoredHarnessSession): Promise<void>;
  remove(session: HarnessSessionKey, adapterId: string): Promise<void>;
}

export interface HarnessPersistence {
  events: HarnessEventStore;
  sessions: HarnessSessionStore;
}

export interface HarnessRun {
  readonly runId: string;
  readonly turnId: string;
  readonly events: AsyncIterable<HarnessEvent>;
  readonly done: Promise<HarnessTurnStatus>;
  cancel(): Promise<void>;
  respond(interactionId: string, response: HarnessInteractionResponse): Promise<void>;
}

export interface HarnessRuntime {
  capabilities(adapterId: string): Promise<HarnessCapabilities>;
  start(request: HarnessRunRequest): HarnessRun;
  close(): Promise<void>;
}

export interface HarnessRuntimeOptions {
  adapters: readonly HarnessAdapter[];
  persistence: HarnessPersistence;
  tools?: HarnessToolHost;
  contextSources?: readonly HarnessContextSource<HarnessContextContribution, HarnessContextPrepareRequest>[];
  onContextError?: HarnessContextPreparationOptions<HarnessContextContribution, HarnessContextPrepareRequest>["onError"];
  createId?: () => string;
  now?: () => Date;
}

export class HarnessRuntimeError extends Error {
  constructor(readonly code: "UNKNOWN_ADAPTER" | "SESSION_BUSY" | "INTERACTION_UNSUPPORTED" | "RUNTIME_CLOSED", message: string) {
    super(message);
    this.name = "HarnessRuntimeError";
  }
}

/** An adapter failure whose message is explicitly safe to show and persist. */
export class HarnessAdapterError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly retryable = false,
  ) {
    super(publicMessage);
    this.name = "HarnessAdapterError";
  }
}

interface ManagedSession {
  adapter: HarnessAdapter;
  session: HarnessAdapterSession;
  active: boolean;
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function safeError(error: unknown): { code: string; message: string; retryable?: boolean } {
  if (error instanceof HarnessAdapterError) {
    return {
      code: error.code,
      message: error.publicMessage,
      ...(error.retryable ? { retryable: true } : {}),
    };
  }
  if (error instanceof HarnessContextPreparationError) {
    return {
      code: error.code,
      message: error.publicMessage,
      ...(error.retryable ? { retryable: true } : {}),
    };
  }
  return { code: "ADAPTER_ERROR", message: "The adapter turn failed." };
}

export function createHarness(options: HarnessRuntimeOptions): HarnessRuntime {
  const adapters = new Map(options.adapters.map((adapter) => [adapter.id, adapter]));
  if (adapters.size !== options.adapters.length) throw new Error("adapter identifiers must be unique");
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const tools = options.tools ?? emptyToolHost;
  const contextSources = options.contextSources ?? [];
  const opened = new Map<string, Promise<ManagedSession>>();
  let closed = false;

  const adapterFor = (id: string): HarnessAdapter => {
    const adapter = adapters.get(id);
    if (!adapter) throw new HarnessRuntimeError("UNKNOWN_ADAPTER", `Unknown harness adapter: ${id}`);
    return adapter;
  };

  const open = (key: HarnessSessionKey, adapter: HarnessAdapter): Promise<ManagedSession> => {
    const id = harnessSessionKey(key, adapter.id);
    const known = opened.get(id);
    if (known) return known;
    const created = options.persistence.sessions.load(key, adapter.id)
      .then(async (stored) => ({
        adapter,
        session: await adapter.open({ session: key, resumeToken: stored?.resumeToken ?? null }),
        active: false,
      }));
    opened.set(id, created);
    void created.catch(() => opened.delete(id));
    return created;
  };

  const persistCheckpoint = async (managed: ManagedSession, key: HarnessSessionKey): Promise<void> => {
    const resumeToken = await managed.session.checkpoint?.() ?? null;
    await options.persistence.sessions.save({
      key,
      adapterId: managed.adapter.id,
      resumeToken,
      updatedAt: now().toISOString(),
    });
  };

  return {
    async capabilities(adapterId) {
      return adapterFor(adapterId).capabilities();
    },

    start(request) {
      if (closed) throw new HarnessRuntimeError("RUNTIME_CLOSED", "The harness runtime is closed.");
      const adapter = adapterFor(request.adapterId);
      const runId = createId();
      const turnId = createId();
      const controller = new AbortController();
      const queue = new AsyncQueue<HarnessEvent>();
      let managed: ManagedSession | null = null;
      let stopping = false;

      const emit = async (payload: HarnessEventPayload): Promise<void> => {
        const event = await options.persistence.events.append({
          schemaVersion: 1,
          session: request.session,
          runId,
          turnId,
          adapterId: adapter.id,
          payload,
        });
        queue.push(event);
      };

      const done = (async (): Promise<HarnessTurnStatus> => {
        const startedAt = now().getTime();
        let status: HarnessTurnStatus = "completed";
        try {
          await emit({
            kind: "turn-started",
            ...(request.model ? { model: request.model } : {}),
            ...(request.accountId ? { accountId: request.accountId } : {}),
          });
          managed = await open(request.session, adapter);
          if (managed.active) throw new HarnessRuntimeError("SESSION_BUSY", "This harness session already has a running turn.");
          managed.active = true;
          const contextRequest: HarnessContextPrepareRequest = {
            ...request,
            runId,
            turnId,
            signal: controller.signal,
          };
          const contextOptions: HarnessContextPreparationOptions<
            HarnessContextContribution,
            HarnessContextPrepareRequest
          > = options.onContextError ? { onError: options.onContextError } : {};
          const context = await prepareHarnessContext(contextSources, contextRequest, contextOptions);
          const toolContext = {
            session: request.session,
            adapterId: adapter.id,
            runId,
            turnId,
            signal: controller.signal,
            context,
          };
          for await (const payload of managed.session.run({
            ...request,
            runId,
            turnId,
            signal: controller.signal,
            context,
            tools: {
              list: () => tools.list(toolContext),
              call: (name, input) => tools.call(name, input, toolContext),
            },
          })) {
            if (controller.signal.aborted) break;
            await emit(payload);
          }
          if (controller.signal.aborted) status = "interrupted";
          await persistCheckpoint(managed, request.session);
        } catch (error) {
          if (controller.signal.aborted || stopping) status = "interrupted";
          else {
            status = "error";
            const failure = safeError(error);
            await emit({ kind: "error", ...failure });
          }
        } finally {
          if (managed) managed.active = false;
          try {
            await emit({
              kind: "turn-completed",
              status,
              usage: { durationMs: Math.max(0, now().getTime() - startedAt) },
            });
          } finally {
            // A failed event store must reject `done`, but never leave readers
            // waiting on a queue no producer can write to again.
            queue.close();
          }
        }
        return status;
      })();

      return {
        runId,
        turnId,
        events: queue,
        done,
        async cancel() {
          if (controller.signal.aborted) return;
          stopping = true;
          controller.abort();
          if (managed?.session.cancel) await managed.session.cancel();
          await done;
        },
        async respond(interactionId, response) {
          const target = managed ?? await open(request.session, adapter);
          if (!target.session.respond) {
            throw new HarnessRuntimeError("INTERACTION_UNSUPPORTED", `${adapter.id} cannot answer interactions.`);
          }
          await target.session.respond(interactionId, response);
        },
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      const sessions = await Promise.allSettled(opened.values());
      await Promise.all(sessions.flatMap((entry) =>
        entry.status === "fulfilled" && entry.value.session.close ? [entry.value.session.close()] : []));
      opened.clear();
    },
  };
}
